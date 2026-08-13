/**
 * Swamp extension model for managing a single systemd unit on a remote Linux
 * host. Transport is delegated to a `@swamp/ssh` fleet model via
 * `ctx.runModel()`.
 *
 * One model instance maps to exactly one unit. The unit may be defined inline
 * via `content` (the literal unit file contents) or may already exist on the
 * system (e.g. installed by apt), in which case `content` is omitted.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  discoverHome,
  ensureDir,
  execSystemctl,
  type RemoteContext,
  runRemoteExec,
  shlexQuote,
  SshRefSchema,
  uploadFile,
} from "./_lib/ssh.ts";

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const GlobalArgsSchema = z.object({
  ...SshRefSchema.shape,
  timeoutSeconds: z.number().int().positive().default(300)
    .describe("Per-command timeout passed to @swamp/ssh"),
  unitName: z.string().min(1).describe(
    "Full systemd unit name, e.g. node-exporter.service",
  ),
  content: z.string().optional().describe(
    "Optional literal unit file contents. When omitted, the unit is assumed to already exist on the system.",
  ),
  userMode: z.enum(["system", "user"]).default("system")
    .describe("Manage system units or rootless user units"),
});

const ReadinessSchema = z.object({
  helperServiceName: z.string().describe("Name of the oneshot helper service"),
  helperServiceContent: z.string().describe(
    "Raw systemd .service contents; must be Type=oneshot with ExecStart blocking until ready and RemainAfterExit=yes",
  ),
  timeoutSeconds: z.number().int().positive().default(60),
  pollIntervalSeconds: z.number().int().positive().default(2),
});

const DeployArgsSchema = z.object({
  enable: z.boolean().default(true)
    .describe("Enable the unit after deploying"),
  start: z.boolean().default(false)
    .describe("Start the unit after deploying"),
  readiness: ReadinessSchema.optional(),
});

const StartArgsSchema = z.object({
  readiness: ReadinessSchema.optional(),
});

const StopArgsSchema = z.object({});
const RestartArgsSchema = z.object({});
const StatusArgsSchema = z.object({});

const DestroyArgsSchema = z.object({
  removeFiles: z.boolean().default(true)
    .describe(
      "Remove unit files that were previously uploaded by this model instance",
    ),
});

const FileRecordSchema = z.object({
  remoteName: z.string(),
  targetDir: z.string(),
  sha256: z.string(),
});

const UnitResourceSchema = z.object({
  kind: z.enum(["service", "quadlet"]),
  userMode: z.enum(["system", "user"]),
  host: z.string(),
  user: z.string().optional().describe(
    "Deprecated: user is now owned by the @swamp/ssh fleet definition",
  ),
  unitName: z.string(),
  files: z.array(FileRecordSchema),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  deployedAt: z.string().datetime(),
});

type UnitResource = z.infer<typeof UnitResourceSchema>;

const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  unitName: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().optional(),
  timestamp: z.string().datetime(),
});

const SYSTEMD_UNIT_EXTENSIONS = [
  ".service",
  ".socket",
  ".device",
  ".mount",
  ".automount",
  ".swap",
  ".target",
  ".path",
  ".timer",
  ".slice",
  ".scope",
];

const QUADLET_ONLY_EXTENSIONS = [
  ".container",
  ".volume",
  ".network",
  ".pod",
  ".image",
  ".build",
];

const ALL_KNOWN_EXTENSIONS = [
  ...SYSTEMD_UNIT_EXTENSIONS,
  ...QUADLET_ONLY_EXTENSIONS,
];

/** Decide whether a unit name belongs in the raw systemd or Quadlet directory. */
function getUnitKind(unitName: string): "service" | "quadlet" {
  if (QUADLET_ONLY_EXTENSIONS.some((ext) => unitName.endsWith(ext))) {
    return "quadlet";
  }
  return "service";
}

/** Ensure a unit name has a known extension when we are writing content. */
function validateUnitName(unitName: string): void {
  if (!ALL_KNOWN_EXTENSIONS.some((ext) => unitName.endsWith(ext))) {
    throw new Error(
      `Unit name "${unitName}" does not end with a recognized extension. ` +
        `Known: ${ALL_KNOWN_EXTENSIONS.join(", ")}`,
    );
  }
}

async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getTargetDir(
  unitName: string,
  userMode: "system" | "user",
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<string> {
  const kind = getUnitKind(unitName);
  if (userMode === "system") {
    if (kind === "service") return "/etc/systemd/system/";
    return "/etc/containers/systemd/";
  }
  const home = await discoverHome(
    ctx,
    ga.sshModel,
    ga.host,
    ga.timeoutSeconds,
  );
  if (kind === "service") return `${home}/.config/systemd/user/`;
  return `${home}/.config/containers/systemd/`;
}

/** Directory for raw systemd services, used for readiness helpers. */
async function getSystemdTargetDir(
  userMode: "system" | "user",
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<string> {
  if (userMode === "system") {
    return "/etc/systemd/system/";
  }
  const home = await discoverHome(
    ctx,
    ga.sshModel,
    ga.host,
    ga.timeoutSeconds,
  );
  return `${home}/.config/systemd/user/`;
}

async function runReadinessGate(
  readiness: z.infer<typeof ReadinessSchema>,
  ctx: MethodContext,
  ga: GlobalArgs,
  helperTargetDir: string,
): Promise<void> {
  const helperPath = `${helperTargetDir}${readiness.helperServiceName}`;
  await uploadFile(
    ctx,
    ga.sshModel,
    ga.host,
    helperPath,
    readiness.helperServiceContent,
    ga.userMode,
    ga.sudo,
    ga.timeoutSeconds,
  );

  let result = await execSystemctl(
    ctx,
    ga.sshModel,
    ga.host,
    ga.userMode,
    ga.sudo,
    ["daemon-reload"],
    ga.timeoutSeconds,
  );
  if (result.exitCode !== 0) {
    throw new Error(`daemon-reload failed: ${result.stderr}`);
  }

  result = await execSystemctl(
    ctx,
    ga.sshModel,
    ga.host,
    ga.userMode,
    ga.sudo,
    ["start", readiness.helperServiceName],
    ga.timeoutSeconds,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start readiness helper ${readiness.helperServiceName}: ${result.stderr}`,
    );
  }

  const deadline = Date.now() + readiness.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    result = await execSystemctl(
      ctx,
      ga.sshModel,
      ga.host,
      ga.userMode,
      ga.sudo,
      ["is-active", readiness.helperServiceName],
      ga.timeoutSeconds,
    );
    const state = result.stdout.trim();
    if (state === "active") {
      return;
    }
    if (state === "failed" || state === "inactive") {
      const logs = await execSystemctl(
        ctx,
        ga.sshModel,
        ga.host,
        ga.userMode,
        ga.sudo,
        ["status", readiness.helperServiceName],
        ga.timeoutSeconds,
      );
      throw new Error(
        `Readiness helper ${readiness.helperServiceName} reached state "${state}". ` +
          `Status: ${logs.stdout}\n${logs.stderr}`,
      );
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, readiness.pollIntervalSeconds * 1000);
    await promise;
  }

  throw new Error(
    `Readiness helper ${readiness.helperServiceName} timed out after ${readiness.timeoutSeconds}s`,
  );
}

function buildRunResult(
  method: string,
  globalArgs: GlobalArgs,
  unitName: string,
  commandResult: { stdout: string; stderr: string; exitCode: number | null },
): z.infer<typeof RunResultSchema> {
  return {
    method,
    host: globalArgs.host,
    unitName,
    changed: commandResult.exitCode === 0,
    success: commandResult.exitCode === 0,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    exitCode: commandResult.exitCode ?? undefined,
    timestamp: new Date().toISOString(),
  };
}

interface MethodContext extends RemoteContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  deleteResource: (instanceName: string) => Promise<void>;
}

/** Swamp extension model for remote systemd management. */
export const model = {
  type: "@holi0317/systemd",
  version: "2026.08.13.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    unit: {
      description: "Desired and actual state of the managed systemd unit",
      schema: UnitResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    deploy: {
      description:
        "Upload the unit file if content is provided, run daemon-reload, and optionally enable/start the unit",
      arguments: DeployArgsSchema,
      execute: async (
        args: z.infer<typeof DeployArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const targetDir = await getTargetDir(
          ga.unitName,
          ga.userMode,
          context,
          ga,
        );
        const fileRecords: z.infer<typeof FileRecordSchema>[] = [];

        if (ga.content !== undefined) {
          validateUnitName(ga.unitName);
          await ensureDir(
            context,
            ga.sshModel,
            ga.host,
            targetDir,
            ga.userMode,
            ga.sudo,
            ga.timeoutSeconds,
          );

          const remotePath = `${targetDir}${ga.unitName}`;
          const hash = await sha256(ga.content);
          await uploadFile(
            context,
            ga.sshModel,
            ga.host,
            remotePath,
            ga.content,
            ga.userMode,
            ga.sudo,
            ga.timeoutSeconds,
          );
          fileRecords.push({
            remoteName: ga.unitName,
            targetDir,
            sha256: hash,
          });

          const reload = await execSystemctl(
            context,
            ga.sshModel,
            ga.host,
            ga.userMode,
            ga.sudo,
            ["daemon-reload"],
            ga.timeoutSeconds,
          );
          if (reload.exitCode !== 0) {
            throw new Error(`daemon-reload failed: ${reload.stderr}`);
          }
        }

        let result: {
          stdout: string;
          stderr: string;
          exitCode: number | null;
        } = { stdout: "", stderr: "", exitCode: 0 };

        if (args.enable) {
          result = await execSystemctl(
            context,
            ga.sshModel,
            ga.host,
            ga.userMode,
            ga.sudo,
            ["enable", ga.unitName],
            ga.timeoutSeconds,
          );
          if (result.exitCode !== 0) {
            throw new Error(`enable ${ga.unitName} failed: ${result.stderr}`);
          }
        }

        if (args.start) {
          result = await execSystemctl(
            context,
            ga.sshModel,
            ga.host,
            ga.userMode,
            ga.sudo,
            ["start", ga.unitName],
            ga.timeoutSeconds,
          );
          if (result.exitCode !== 0) {
            throw new Error(`start ${ga.unitName} failed: ${result.stderr}`);
          }
        }

        if (args.readiness && args.start) {
          const helperDir = await getSystemdTargetDir(
            ga.userMode,
            context,
            ga,
          );
          await runReadinessGate(
            args.readiness,
            context,
            ga,
            helperDir,
          );
        }

        const unitHandle = await context.writeResource("unit", "current", {
          kind: getUnitKind(ga.unitName),
          userMode: ga.userMode,
          host: ga.host,
          unitName: ga.unitName,
          files: fileRecords,
          enabled: args.enable,
          active: args.start,
          deployedAt: new Date().toISOString(),
        });

        const runHandle = await context.writeResource(
          "runResult",
          "deploy",
          buildRunResult("deploy", ga, ga.unitName, result),
        );

        return { dataHandles: [unitHandle, runHandle] };
      },
    },

    start: {
      description: "Start the managed systemd unit",
      arguments: StartArgsSchema,
      execute: async (
        args: z.infer<typeof StartArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const result = await execSystemctl(
          context,
          ga.sshModel,
          ga.host,
          ga.userMode,
          ga.sudo,
          ["start", ga.unitName],
          ga.timeoutSeconds,
        );
        if (result.exitCode !== 0) {
          throw new Error(`start ${ga.unitName} failed: ${result.stderr}`);
        }

        if (args.readiness) {
          const helperDir = await getSystemdTargetDir(
            ga.userMode,
            context,
            ga,
          );
          await runReadinessGate(
            args.readiness,
            context,
            ga,
            helperDir,
          );
        }

        const runHandle = await context.writeResource(
          "runResult",
          "start",
          buildRunResult("start", ga, ga.unitName, result),
        );
        return { dataHandles: [runHandle] };
      },
    },

    stop: {
      description: "Stop the managed systemd unit",
      arguments: StopArgsSchema,
      execute: async (
        _args: z.infer<typeof StopArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const result = await execSystemctl(
          context,
          ga.sshModel,
          ga.host,
          ga.userMode,
          ga.sudo,
          ["stop", ga.unitName],
          ga.timeoutSeconds,
        );
        if (result.exitCode !== 0) {
          throw new Error(`stop ${ga.unitName} failed: ${result.stderr}`);
        }
        const runHandle = await context.writeResource(
          "runResult",
          "stop",
          buildRunResult("stop", ga, ga.unitName, result),
        );
        return { dataHandles: [runHandle] };
      },
    },

    restart: {
      description: "Restart the managed systemd unit",
      arguments: RestartArgsSchema,
      execute: async (
        _args: z.infer<typeof RestartArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const result = await execSystemctl(
          context,
          ga.sshModel,
          ga.host,
          ga.userMode,
          ga.sudo,
          ["restart", ga.unitName],
          ga.timeoutSeconds,
        );
        if (result.exitCode !== 0) {
          throw new Error(`restart ${ga.unitName} failed: ${result.stderr}`);
        }
        const runHandle = await context.writeResource(
          "runResult",
          "restart",
          buildRunResult("restart", ga, ga.unitName, result),
        );
        return { dataHandles: [runHandle] };
      },
    },

    status: {
      description: "Query active/sub/enabled state for the managed unit",
      arguments: StatusArgsSchema,
      execute: async (
        _args: z.infer<typeof StatusArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const result = await execSystemctl(
          context,
          ga.sshModel,
          ga.host,
          ga.userMode,
          ga.sudo,
          [
            "show",
            ga.unitName,
            "-p",
            "ActiveState",
            "-p",
            "SubState",
            "-p",
            "UnitFileState",
            "-p",
            "LoadState",
          ],
          ga.timeoutSeconds,
        );

        const runHandle = await context.writeResource(
          "runResult",
          "status",
          buildRunResult("status", ga, ga.unitName, result),
        );
        return { dataHandles: [runHandle] };
      },
    },

    destroy: {
      description:
        "Stop/disable the unit and optionally remove tracked unit files",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const stored = await context.readResource("current");
        let files: z.infer<typeof FileRecordSchema>[] = [];
        let hadResource = false;

        if (stored) {
          const parsed = UnitResourceSchema.safeParse(stored);
          if (parsed.success) {
            files = parsed.data.files;
            hadResource = true;
          }
        }

        let result = await execSystemctl(
          context,
          ga.sshModel,
          ga.host,
          ga.userMode,
          ga.sudo,
          ["stop", ga.unitName],
          ga.timeoutSeconds,
        );
        if (result.exitCode !== 0) {
          throw new Error(`stop ${ga.unitName} failed: ${result.stderr}`);
        }

        result = await execSystemctl(
          context,
          ga.sshModel,
          ga.host,
          ga.userMode,
          ga.sudo,
          ["disable", ga.unitName],
          ga.timeoutSeconds,
        );
        if (result.exitCode !== 0) {
          throw new Error(`disable ${ga.unitName} failed: ${result.stderr}`);
        }

        let removedFiles = false;
        if (args.removeFiles && files.length > 0) {
          for (const file of files) {
            const remotePath = `${file.targetDir}${file.remoteName}`;
            const rmResult = await runRemoteExec(
              context,
              ga.sshModel,
              ga.host,
              {
                command: `rm -f ${shlexQuote(remotePath)}`,
                sudo: ga.userMode === "system" && ga.sudo,
                timeoutSec: ga.timeoutSeconds,
              },
            );
            if (rmResult.exitCode !== 0) {
              throw new Error(
                `Failed to remove ${remotePath}: ${rmResult.stderr}`,
              );
            }
          }
          removedFiles = true;
        }

        if (removedFiles) {
          result = await execSystemctl(
            context,
            ga.sshModel,
            ga.host,
            ga.userMode,
            ga.sudo,
            ["daemon-reload"],
            ga.timeoutSeconds,
          );
          if (result.exitCode !== 0) {
            throw new Error(`daemon-reload failed: ${result.stderr}`);
          }
        }

        if (hadResource) {
          await context.deleteResource("current");
        }

        const runHandle = await context.writeResource(
          "runResult",
          "destroy",
          buildRunResult("destroy", ga, ga.unitName, result),
        );
        return { dataHandles: [runHandle] };
      },
    },
  },
};
