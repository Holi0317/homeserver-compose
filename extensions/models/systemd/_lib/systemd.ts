import * as z from "zod";
import {
  discoverHome,
  ensureDir,
  type RemoteContext,
  runRemoteExec,
  shlexQuote,
  uploadFile,
  usesSudo,
} from "@holi0317/remote-ssh";

const RAW_EXTENSIONS = [
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
] as const;
const QUADLET_EXTENSIONS = [
  ".container",
  ".volume",
  ".network",
  ".pod",
  ".image",
  ".build",
] as const;

type ModelKind = "unit" | "quadlet";
export type RemoteTarget = z.infer<typeof RemoteTargetSchema>;
export interface GlobalArgs {
  remote: RemoteTarget;
  timeoutSeconds: number;
  unitName: string;
  content?: string;
  userMode: "system" | "user";
  enabled?: boolean;
  state?: "running" | "stopped";
}
type FileRecord = z.infer<typeof FileRecordSchema>;
type StoredState =
  | z.infer<typeof UnitStateSchema>
  | z.infer<typeof QuadletStateSchema>;

export const RemoteTargetSchema = z.object({
  fleet: z.string().min(1).describe("@swamp/ssh fleet model instance"),
  host: z.string().min(1).describe("Logical host name in the fleet"),
  sudo: z.boolean().default(false).describe(
    "Use sudo for system-mode systemctl and file operations",
  ),
});

const FileRecordSchema = z.object({
  remoteName: z.string(),
  targetDir: z.string(),
  sha256: z.string(),
});

const UnitStateSchema = z.object({
  userMode: z.enum(["system", "user"]),
  fleet: z.string().optional(),
  host: z.string(),
  sudo: z.boolean().optional(),
  unitName: z.string(),
  files: z.array(FileRecordSchema),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  deployedAt: z.iso.datetime(),
});

const QuadletStateSchema = z.object({
  userMode: z.enum(["system", "user"]),
  fleet: z.string().optional(),
  host: z.string(),
  sudo: z.boolean().optional(),
  sourceName: z.string(),
  generatedUnitName: z.string(),
  wantedBy: z.array(z.string()).optional(),
  files: z.array(FileRecordSchema),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  deployedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  unitName: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable().optional(),
  replacementRequired: z.boolean().optional(),
  recreated: z.boolean().optional(),
  oldIdentity: z.string().optional(),
  newIdentity: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.iso.datetime(),
});

const ReadinessSchema = z.object({
  helperServiceName: z.string().min(1)
    .refine(
      (name) => isSafeUnitName(name),
      "must be a single unit name without path separators or control characters",
    )
    .refine((name) => name.endsWith(".service"), "must be a raw .service name"),
  helperServiceContent: z.string().describe(
    "Raw systemd .service contents; must be Type=oneshot with a blocking ExecStart",
  ),
  timeoutSeconds: z.number().int().positive().default(60),
  pollIntervalSeconds: z.number().int().positive().default(2),
});

const DestroyArgsSchema = z.object({
  removeFiles: z.boolean().default(true).describe(
    "Remove unit files previously uploaded by this model instance",
  ),
});

function isSafeUnitName(value: string): boolean {
  return value !== "." && value !== ".." &&
    !value.includes("/") && !value.includes("\\") &&
    !/[\0\r\n]/.test(value);
}

function assertSafeUnitName(value: string, label: string): void {
  if (!isSafeUnitName(value)) {
    throw new Error(
      `${label} must be a single unit name without path separators or control characters`,
    );
  }
}

function makeGlobalArgsSchema(kind: ModelKind) {
  const extensions = kind === "unit" ? RAW_EXTENSIONS : QUADLET_EXTENSIONS;
  return z.object({
    remote: RemoteTargetSchema,
    timeoutSeconds: z.number().int().positive().default(300)
      .describe("Per-command timeout passed to @swamp/ssh"),
    unitName: z.string().min(1)
      .refine(
        (name) => isSafeUnitName(name),
        "must be a single unit name without path separators or control characters",
      )
      .refine(
        (name) => extensions.some((extension) => name.endsWith(extension)),
        `must end with a ${
          kind === "unit" ? "raw systemd" : "Quadlet"
        } suffix (${extensions.join(", ")})`,
      ),

    content: z.string().optional().describe(
      kind === "unit"
        ? "Optional literal raw systemd unit contents"
        : "Optional literal Quadlet source contents",
    ),
    userMode: z.enum(["system", "user"]).default("system"),
    enabled: z.boolean().optional().describe(
      "If provided, converge whether the resource is enabled",
    ),
    state: z.enum(["running", "stopped"]).optional().describe(
      "If provided, converge the active state",
    ),
  });
}

function systemdUnitName(sourceName: string): string {
  if (sourceName.endsWith(".container")) {
    return `${sourceName.slice(0, -10)}.service`;
  }
  for (const extension of QUADLET_EXTENSIONS) {
    if (extension !== ".container" && sourceName.endsWith(extension)) {
      return `${sourceName.slice(0, -extension.length)}-${
        extension.slice(1)
      }.service`;
    }
  }
  return sourceName;
}

function wantedByTargets(content: string): string[] {
  const targets: string[] = [];
  let inInstall = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inInstall = trimmed === "[Install]";
      continue;
    }
    if (inInstall && trimmed.toLowerCase().startsWith("wantedby=")) {
      targets.push(...trimmed.slice("wantedby=".length).trim().split(/\s+/));
    }
  }
  const result = targets.filter(Boolean);
  const wantedBy = result.length > 0 ? result : ["default.target"];
  for (const target of wantedBy) assertSafeUnitName(target, "WantedBy target");
  return wantedBy;
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
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

function execSystemctl(
  ctx: MethodContext,
  definition: string,
  host: string,
  userMode: "system" | "user",
  sudo: boolean,
  subcommand: string[],
  timeoutSec: number,
  okExitCodes?: number[],
) {
  const parts = ["systemctl"];
  if (userMode === "user") parts.push("--user");
  parts.push(...subcommand);
  return runRemoteExec(ctx, definition, host, {
    command: parts.map(shlexQuote).join(" "),
    sudo: usesSudo(userMode, sudo),
    timeoutSec,
    okExitCodes,
  });
}

async function targetDir(
  kind: ModelKind,
  userMode: "system" | "user",
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<string> {
  if (userMode === "system") {
    return kind === "unit"
      ? "/etc/systemd/system/"
      : "/etc/containers/systemd/";
  }
  const home = await discoverHome(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.timeoutSeconds,
  );
  return kind === "unit"
    ? `${home}/.config/systemd/user/`
    : `${home}/.config/containers/systemd/`;
}

async function rawTargetDir(
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<string> {
  if (ga.userMode === "system") return "/etc/systemd/system/";
  const home = await discoverHome(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.timeoutSeconds,
  );
  return `${home}/.config/systemd/user/`;
}

async function readinessGate(
  readiness: z.infer<typeof ReadinessSchema>,
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<void> {
  const helperPath = `${await rawTargetDir(
    ctx,
    ga,
  )}${readiness.helperServiceName}`;
  await uploadFile(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    helperPath,
    readiness.helperServiceContent,
    ga.userMode,
    ga.remote.sudo,
    ga.timeoutSeconds,
  );
  let result = await execSystemctl(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.userMode,
    ga.remote.sudo,
    ["daemon-reload"],
    ga.timeoutSeconds,
  );
  if (result.exitCode !== 0) {
    throw new Error(`daemon-reload failed: ${result.stderr}`);
  }
  result = await execSystemctl(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.userMode,
    ga.remote.sudo,
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
      ga.remote.fleet,
      ga.remote.host,
      ga.userMode,
      ga.remote.sudo,
      ["is-active", readiness.helperServiceName],
      ga.timeoutSeconds,
      [0, 3],
    );
    const state = result.stdout.trim();
    if (state === "active") return;
    if (state === "failed" || state === "inactive") {
      const status = await execSystemctl(
        ctx,
        ga.remote.fleet,
        ga.remote.host,
        ga.userMode,
        ga.remote.sudo,
        ["status", readiness.helperServiceName],
        ga.timeoutSeconds,
      );
      throw new Error(
        `Readiness helper ${readiness.helperServiceName} reached state "${state}". Status: ${status.stdout}\n${status.stderr}`,
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, readiness.pollIntervalSeconds * 1000)
    );
  }
  throw new Error(
    `Readiness helper ${readiness.helperServiceName} timed out after ${readiness.timeoutSeconds}s`,
  );
}

function resultData(
  method: string,
  ga: GlobalArgs,
  unitName: string,
  result: { stdout: string; stderr: string; exitCode: number | null },
  extra: Record<string, unknown> = {},
): z.infer<typeof RunResultSchema> {
  return {
    method,
    host: ga.remote.host,
    unitName,
    changed: result.exitCode === 0,
    success: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function unitNameFor(kind: ModelKind, name: string): string {
  return kind === "quadlet" ? systemdUnitName(name) : name;
}
function resourceIdentity(kind: ModelKind, resource: {
  userMode: "system" | "user";
  fleet?: string;
  host: string;
  unitName?: string;
  sourceName?: string;
}): string {
  const name = kind === "unit" ? resource.unitName : resource.sourceName;
  if (!name) throw new Error(`Missing ${kind} resource identity`);
  return `${kind}:${
    resource.fleet ?? "<unknown>"
  }:${resource.host}:${resource.userMode}:${name}`;
}

async function runDestroy(
  kind: ModelKind,
  state: StoredState,
  args: z.infer<typeof DestroyArgsSchema>,
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const oldName = kind === "quadlet"
    ? (state as z.infer<typeof QuadletStateSchema>).sourceName
    : (state as z.infer<typeof UnitStateSchema>).unitName;
  assertSafeUnitName(oldName, "Stored unit name");

  const generatedName = unitNameFor(kind, oldName);
  let result = await execSystemctl(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.userMode,
    ga.remote.sudo,
    ["stop", generatedName],
    ga.timeoutSeconds,
  );
  if (result.exitCode !== 0) {
    throw new Error(`stop ${oldName} failed: ${result.stderr}`);
  }
  result = await execSystemctl(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.userMode,
    ga.remote.sudo,
    ["disable", generatedName],
    ga.timeoutSeconds,
  );
  if (result.exitCode !== 0) {
    throw new Error(`disable ${oldName} failed: ${result.stderr}`);
  }
  if (kind === "quadlet") {
    const targets = (state as z.infer<typeof QuadletStateSchema>).wantedBy ??
      ["default.target"];
    for (const target of targets) {
      assertSafeUnitName(target, "Stored WantedBy target");
    }
    const wantsBase = ga.userMode === "system"
      ? "/etc/systemd/system"
      : `${await discoverHome(
        ctx,
        ga.remote.fleet,
        ga.remote.host,
        ga.timeoutSeconds,
      )}/.config/systemd/user`;
    for (const target of targets) {
      const removed = await runRemoteExec(
        ctx,
        ga.remote.fleet,
        ga.remote.host,
        {
          command: `rm -f ${
            shlexQuote(`${wantsBase}/${target}.wants/${generatedName}`)
          }`,
          sudo: ga.userMode === "system" && ga.remote.sudo,
          timeoutSec: ga.timeoutSeconds,
        },
      );
      if (removed.exitCode !== 0) {
        throw new Error(
          `Failed to remove Quadlet enablement link for ${oldName}: ${removed.stderr}`,
        );
      }
    }
  }
  if (args.removeFiles) {
    for (const file of state.files) {
      const removed = await runRemoteExec(
        ctx,
        ga.remote.fleet,
        ga.remote.host,
        {
          command: `rm -f ${shlexQuote(`${file.targetDir}${file.remoteName}`)}`,
          sudo: ga.userMode === "system" && ga.remote.sudo,
          timeoutSec: ga.timeoutSeconds,
        },
      );
      if (removed.exitCode !== 0) {
        throw new Error(
          `Failed to remove ${file.targetDir}${file.remoteName}: ${removed.stderr}`,
        );
      }
      result = removed;
    }
  }
  if (kind === "quadlet" || (args.removeFiles && state.files.length > 0)) {
    result = await execSystemctl(
      ctx,
      ga.remote.fleet,
      ga.remote.host,
      ga.userMode,
      ga.remote.sudo,
      ["daemon-reload"],
      ga.timeoutSeconds,
    );
    if (result.exitCode !== 0) {
      throw new Error(`daemon-reload failed: ${result.stderr}`);
    }
  }
  return result;
}

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

async function setQuadletEnablement(
  ctx: MethodContext,
  ga: GlobalArgs,
  generatedName: string,
  targets: string[],
  enabled: boolean,
): Promise<CommandResult> {
  const homeBase = ga.userMode === "user"
    ? `${await discoverHome(
      ctx,
      ga.remote.fleet,
      ga.remote.host,
      ga.timeoutSeconds,
    )}/.config/systemd/user`
    : "/etc/systemd/system";
  const needsSudo = usesSudo(ga.userMode, ga.remote.sudo);
  const commands = targets.map((target) => {
    const wantsDir = `${homeBase}/${target}.wants`;
    const link = `${wantsDir}/${generatedName}`;
    const inner = enabled
      ? `sourcePrefix=${
        ga.userMode === "user"
          ? "/run/user/$(id -u)/systemd/generator"
          : "/run/systemd/generator"
      } && mkdir -p ${shlexQuote(wantsDir)} && ln -sf "$sourcePrefix"/${
        shlexQuote(generatedName)
      } ${shlexQuote(link)}`
      : `rm -f ${shlexQuote(link)}`;
    return needsSudo ? `sudo -n -- sh -c ${shlexQuote(inner)}` : inner;
  }).join(" && ");
  const result = await runRemoteExec(ctx, ga.remote.fleet, ga.remote.host, {
    command: commands,
    timeoutSec: ga.timeoutSeconds,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${
        enabled ? "enable" : "disable"
      } ${ga.unitName} failed: ${result.stderr}`,
    );
  }
  return result;
}

async function readLifecycleState(
  kind: ModelKind,
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<{ enabled: boolean; active: boolean }> {
  const generatedName = unitNameFor(kind, ga.unitName);
  const enabledResult = await execSystemctl(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.userMode,
    ga.remote.sudo,
    ["is-enabled", generatedName],
    ga.timeoutSeconds,
    [0, 1, 3],
  );
  const activeResult = await execSystemctl(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.userMode,
    ga.remote.sudo,
    ["is-active", generatedName],
    ga.timeoutSeconds,
    [0, 3],
  );
  return {
    enabled: enabledResult.exitCode === 0,
    active: activeResult.stdout.trim() === "active",
  };
}

async function applyDesired(
  kind: ModelKind,
  args: z.infer<typeof ApplyArgsSchema>,
  ctx: MethodContext,
  ga: GlobalArgs,
  previousState?: StoredState,
): Promise<{
  result: CommandResult;
  files: FileRecord[];
  wantedBy: string[];
  lifecycle: { enabled: boolean; active: boolean };
  changed: boolean;
}> {
  const dir = await targetDir(kind, ga.userMode, ctx, ga);
  const files: FileRecord[] = [];
  const previousQuadlet = previousState && "sourceName" in previousState
    ? previousState
    : undefined;
  const wantedBy = kind === "quadlet"
    ? ga.content !== undefined
      ? wantedByTargets(ga.content)
      : previousQuadlet?.wantedBy ?? ["default.target"]
    : [];
  let result: CommandResult = { stdout: "", stderr: "", exitCode: 0 };
  let changed = false;

  if (ga.content !== undefined) {
    await ensureDir(
      ctx,
      ga.remote.fleet,
      ga.remote.host,
      dir,
      ga.userMode,
      ga.remote.sudo,
      ga.timeoutSeconds,
    );
    const path = `${dir}${ga.unitName}`;
    await uploadFile(
      ctx,
      ga.remote.fleet,
      ga.remote.host,
      path,
      ga.content,
      ga.userMode,
      ga.remote.sudo,
      ga.timeoutSeconds,
    );
    files.push({
      remoteName: ga.unitName,
      targetDir: dir,
      sha256: await sha256(ga.content),
    });
    result = await execSystemctl(
      ctx,
      ga.remote.fleet,
      ga.remote.host,
      ga.userMode,
      ga.remote.sudo,
      ["daemon-reload"],
      ga.timeoutSeconds,
    );
    if (result.exitCode !== 0) {
      throw new Error(`daemon-reload failed: ${result.stderr}`);
    }
    changed = true;
  }

  const generatedName = unitNameFor(kind, ga.unitName);
  if (ga.enabled !== undefined) {
    if (kind === "quadlet") {
      result = await setQuadletEnablement(
        ctx,
        ga,
        generatedName,
        wantedBy,
        ga.enabled,
      );
    } else {
      result = await execSystemctl(
        ctx,
        ga.remote.fleet,
        ga.remote.host,
        ga.userMode,
        ga.remote.sudo,
        [ga.enabled ? "enable" : "disable", generatedName],
        ga.timeoutSeconds,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `${
            ga.enabled ? "enable" : "disable"
          } ${ga.unitName} failed: ${result.stderr}`,
        );
      }
    }
    changed = true;
  }

  if (ga.state !== undefined) {
    result = await execSystemctl(
      ctx,
      ga.remote.fleet,
      ga.remote.host,
      ga.userMode,
      ga.remote.sudo,
      [ga.state === "running" ? "start" : "stop", generatedName],
      ga.timeoutSeconds,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `${
          ga.state === "running" ? "start" : "stop"
        } ${ga.unitName} failed: ${result.stderr}`,
      );
    }
    changed = true;
  }

  if (args.readiness && ga.state === "running") {
    await readinessGate(args.readiness, ctx, ga);
  }

  const lifecycle = await readLifecycleState(kind, ctx, ga);
  return { result, files, wantedBy, lifecycle, changed };
}

const ApplyArgsSchema = z.object({
  allowRecreate: z.boolean().default(false).describe(
    "Permit destroy-then-create replacement",
  ),
  readiness: ReadinessSchema.optional(),
});

export function createSystemdModel(kind: ModelKind) {
  const GlobalArgsSchema = makeGlobalArgsSchema(kind);
  const StateSchema = kind === "unit" ? UnitStateSchema : QuadletStateSchema;
  return {
    type: `@holi0317/systemd/${kind}`,
    version: "2026.08.16.2",
    globalArguments: GlobalArgsSchema,
    resources: {
      unit: {
        description: kind === "unit"
          ? "Managed raw systemd unit state"
          : "Managed Quadlet source and generated unit state",
        schema: StateSchema,
        lifetime: "infinite",
        garbageCollection: 10,
      },
      runResult: {
        description:
          "Outcome or diagnostic state for a systemd method invocation",
        schema: RunResultSchema,
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      check: {
        description: "Observe the managed unit without mutation",
        arguments: z.object({}),
        execute: async (
          _args: Record<string, never>,
          context: MethodContext,
        ) => {
          const ga = context.globalArgs;
          const result = await execSystemctl(
            context,
            ga.remote.fleet,
            ga.remote.host,
            ga.userMode,
            ga.remote.sudo,
            [
              "show",
              unitNameFor(kind, ga.unitName),
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
          const handle = await context.writeResource(
            "runResult",
            "check",
            resultData("check", ga, ga.unitName, result, { changed: false }),
          );
          return { dataHandles: [handle] };
        },
      },
      apply: {
        description:
          "Converge the resource, requiring explicit consent for replacement",
        arguments: ApplyArgsSchema,
        execute: async (
          args: z.infer<typeof ApplyArgsSchema>,
          context: MethodContext,
        ) => {
          const ga = context.globalArgs;
          const storedRaw = await context.readResource("current");
          const stored = storedRaw ? StateSchema.safeParse(storedRaw) : null;
          const storedData = stored?.success
            ? stored.data as StoredState
            : undefined;
          const oldIdentity = storedData
            ? resourceIdentity(kind, storedData)
            : undefined;
          const newIdentity = resourceIdentity(kind, {
            userMode: ga.userMode,
            fleet: ga.remote.fleet,
            host: ga.remote.host,
            ...(kind === "unit"
              ? { unitName: ga.unitName }
              : { sourceName: ga.unitName }),
          });
          const replacement = oldIdentity !== undefined &&
            oldIdentity !== newIdentity;
          if (replacement && !args.allowRecreate) {
            const diagnostic = await context.writeResource(
              "runResult",
              "apply",
              resultData(
                "apply",
                ga,
                ga.unitName,
                { stdout: "", stderr: "", exitCode: null },
                {
                  success: false,
                  changed: false,
                  replacementRequired: true,
                  oldIdentity,
                  newIdentity,
                  error:
                    `Replacement required: ${oldIdentity} -> ${newIdentity}. ` +
                    "Re-run apply with allowRecreate: true after reviewing the destructive change.",
                },
              ),
            );
            throw new Error(
              `Replacement required for ${oldIdentity} -> ${newIdentity}; ` +
                "set allowRecreate: true to permit destroy-then-create " +
                `(diagnostic: ${diagnostic.name})`,
            );
          }

          let replacementStarted = false;
          let recreated = false;
          try {
            if (replacement && storedData) {
              replacementStarted = true;
              const previousState = storedData as StoredState & {
                fleet?: string;
                sudo?: boolean;
              };
              const destroyArgs: GlobalArgs = {
                ...ga,
                userMode: previousState.userMode,
                remote: {
                  fleet: previousState.fleet ?? ga.remote.fleet,
                  host: previousState.host,
                  sudo: previousState.sudo ?? ga.remote.sudo,
                },
              };
              await runDestroy(
                kind,
                previousState,
                { removeFiles: true },
                context,
                destroyArgs,
              );
              await context.deleteResource("current");
              recreated = true;
            }

            const preservedFiles = storedData && !replacement
              ? storedData.files
              : [];
            const applied = await applyDesired(
              kind,
              args,
              context,
              ga,
              storedData,
            );
            const files = applied.files.length > 0
              ? applied.files
              : preservedFiles;
            const state = kind === "unit"
              ? {
                userMode: ga.userMode,
                fleet: ga.remote.fleet,
                host: ga.remote.host,
                sudo: ga.remote.sudo,
                unitName: ga.unitName,
                files,
                enabled: applied.lifecycle.enabled,
                active: applied.lifecycle.active,
                deployedAt: new Date().toISOString(),
              }
              : {
                userMode: ga.userMode,
                fleet: ga.remote.fleet,
                host: ga.remote.host,
                sudo: ga.remote.sudo,
                sourceName: ga.unitName,
                generatedUnitName: systemdUnitName(ga.unitName),
                wantedBy: applied.wantedBy,
                files,
                enabled: applied.lifecycle.enabled,
                active: applied.lifecycle.active,
                deployedAt: new Date().toISOString(),
              };
            const stateHandle = await context.writeResource(
              "unit",
              "current",
              state,
            );
            const resultHandle = await context.writeResource(
              "runResult",
              "apply",
              resultData(
                "apply",
                ga,
                ga.unitName,
                applied.result,
                {
                  changed: applied.changed,
                  recreated,
                  ...(recreated ? { oldIdentity, newIdentity } : {}),
                },
              ),
            );
            return { dataHandles: [stateHandle, resultHandle] };
          } catch (error) {
            if (replacementStarted) {
              await context.writeResource(
                "runResult",
                "apply",
                resultData(
                  "apply",
                  ga,
                  ga.unitName,
                  { stdout: "", stderr: "", exitCode: null },
                  {
                    success: false,
                    changed: true,
                    replacementRequired: true,
                    recreated,
                    oldIdentity,
                    newIdentity,
                    error: error instanceof Error
                      ? error.message
                      : String(error),
                  },
                ),
              );
            }
            throw error;
          }
        },
      },
      start: {
        description: "Start the managed systemd unit",
        arguments: z.object({ readiness: ReadinessSchema.optional() }),
        execute: async (
          args: { readiness?: z.infer<typeof ReadinessSchema> },
          context: MethodContext,
        ) => {
          const ga = context.globalArgs;
          const result = await execSystemctl(
            context,
            ga.remote.fleet,
            ga.remote.host,
            ga.userMode,
            ga.remote.sudo,
            ["start", unitNameFor(kind, ga.unitName)],
            ga.timeoutSeconds,
          );
          if (result.exitCode !== 0) {
            throw new Error(`start ${ga.unitName} failed: ${result.stderr}`);
          }
          if (args.readiness) await readinessGate(args.readiness, context, ga);
          const handle = await context.writeResource(
            "runResult",
            "start",
            resultData("start", ga, ga.unitName, result),
          );
          return { dataHandles: [handle] };
        },
      },
      stop: {
        description: "Stop the managed systemd unit",
        arguments: z.object({}),
        execute: async (
          _args: Record<string, never>,
          context: MethodContext,
        ) => {
          const ga = context.globalArgs;
          const result = await execSystemctl(
            context,
            ga.remote.fleet,
            ga.remote.host,
            ga.userMode,
            ga.remote.sudo,
            ["stop", unitNameFor(kind, ga.unitName)],
            ga.timeoutSeconds,
          );
          if (result.exitCode !== 0) {
            throw new Error(`stop ${ga.unitName} failed: ${result.stderr}`);
          }
          const handle = await context.writeResource(
            "runResult",
            "stop",
            resultData("stop", ga, ga.unitName, result),
          );
          return { dataHandles: [handle] };
        },
      },
      restart: {
        description: "Restart the managed systemd unit",
        arguments: z.object({}),
        execute: async (
          _args: Record<string, never>,
          context: MethodContext,
        ) => {
          const ga = context.globalArgs;
          const result = await execSystemctl(
            context,
            ga.remote.fleet,
            ga.remote.host,
            ga.userMode,
            ga.remote.sudo,
            ["restart", unitNameFor(kind, ga.unitName)],
            ga.timeoutSeconds,
          );
          if (result.exitCode !== 0) {
            throw new Error(`restart ${ga.unitName} failed: ${result.stderr}`);
          }
          const handle = await context.writeResource(
            "runResult",
            "restart",
            resultData("restart", ga, ga.unitName, result),
          );
          return { dataHandles: [handle] };
        },
      },
      status: {
        description: "Query active, sub, enabled, and load state",
        arguments: z.object({}),
        execute: async (
          _args: Record<string, never>,
          context: MethodContext,
        ) => {
          const ga = context.globalArgs;
          const result = await execSystemctl(
            context,
            ga.remote.fleet,
            ga.remote.host,
            ga.userMode,
            ga.remote.sudo,
            [
              "show",
              unitNameFor(kind, ga.unitName),
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
          const handle = await context.writeResource(
            "runResult",
            "status",
            resultData("status", ga, ga.unitName, result, { changed: false }),
          );
          return { dataHandles: [handle] };
        },
      },
      destroy: {
        description:
          "Stop, disable, and remove only files tracked by this model",
        arguments: DestroyArgsSchema,
        execute: async (
          args: z.infer<typeof DestroyArgsSchema>,
          context: MethodContext,
        ) => {
          const ga = context.globalArgs;
          const storedRaw = await context.readResource("current");
          const stored = storedRaw ? StateSchema.safeParse(storedRaw) : null;
          const hasState = stored?.success === true;
          let result: {
            stdout: string;
            stderr: string;
            exitCode: number | null;
          } = {
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
          if (hasState) {
            result = await runDestroy(
              kind,
              stored.data as StoredState,
              args,
              context,
              ga,
            );
            await context.deleteResource("current");
          }
          const handle = await context.writeResource(
            "runResult",
            "destroy",
            resultData("destroy", ga, ga.unitName, result, {
              changed: hasState,
            }),
          );
          return { dataHandles: [handle] };
        },
      },
    },
  };
}
