/**
 * Remote execution helpers for the systemd extension model.
 *
 * This module no longer builds raw SSH/Tailscale argv. Instead it delegates
 * every remote operation to a `@swamp/ssh` fleet model via `ctx.runModel()`.
 * That gives us ControlMaster multiplexing, Tailscale support, retries,
 * auditing, and output capture without reimplementing the transport.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Reference to the `@swamp/ssh` fleet model instance and target host. */
export const SshRefSchema = z.object({
  sshModel: z.string().min(1).describe(
    "Name of the @swamp/ssh fleet model instance that knows the host",
  ),
  host: z.string().min(1).describe(
    "Host name in the fleet that this unit belongs to",
  ),
  sudo: z.boolean().default(false).describe(
    "Use sudo for system-mode systemctl and file operations",
  ),
});

export type SshRef = z.infer<typeof SshRefSchema>;

/** Minimal result shape returned by `@swamp/ssh` runResult resources. */
export interface RemoteRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Resource entry returned by `ctx.runModel()`. */
interface RunModelResource {
  name: string;
  tags?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

/** Method context surface needed to drive `@swamp/ssh`. */
export interface RemoteContext {
  runModel?: (
    req: {
      definition: string;
      method: string;
      arguments: Record<string, unknown>;
    },
  ) => Promise<
    {
      ok: boolean;
      error?: { message: string };
      resources: RunModelResource[];
    }
  >;
  readResource: (
    name: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  logger?: {
    debug: (msg: string, props?: Record<string, unknown>) => void;
  };
}

const SshRunResultResourceSchema = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
});

/** Quote a string for safe use as a single literal word in a POSIX shell. */
export function shlexQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Decide whether system-mode operations need sudo on this host. */
export function usesSudo(userMode: "system" | "user", sudo: boolean): boolean {
  return userMode === "system" && sudo;
}

function parseRunResult(
  resource: RunModelResource,
): RemoteRunResult {
  const parsed = SshRunResultResourceSchema.parse(resource.attributes ?? {});
  return {
    stdout: parsed.stdout ?? "",
    stderr: parsed.stderr ?? "",
    exitCode: parsed.exitCode ?? null,
  };
}

function assertRunModel(
  ctx: RemoteContext,
): NonNullable<RemoteContext["runModel"]> {
  if (!ctx.runModel) {
    throw new Error(
      "runModel is unavailable in this execution context. " +
        "The systemd model must be run locally or in a workflow.",
    );
  }
  return ctx.runModel;
}

/**
 * Run a single shell command on the target host through `@swamp/ssh` exec.
 */
export async function runRemoteExec(
  ctx: RemoteContext,
  definition: string,
  host: string,
  options: {
    command: string;
    sudo?: boolean;
    okExitCodes?: number[] | "any";
    timeoutSec?: number;
    env?: Record<string, string>;
    captureOutput?: boolean;
  },
): Promise<RemoteRunResult> {
  const runModel = assertRunModel(ctx);

  const args: Record<string, unknown> = {
    hosts: host,
    command: options.command,
  };
  if (options.sudo) args.sudo = true;
  if (options.okExitCodes !== undefined) args.okExitCodes = options.okExitCodes;
  if (options.timeoutSec !== undefined) args.timeoutSec = options.timeoutSec;
  if (options.env !== undefined) args.env = options.env;
  if (options.captureOutput !== undefined) {
    args.captureOutput = options.captureOutput;
  }

  const run = await runModel({
    definition,
    method: "exec",
    arguments: args,
  });

  if (!run.ok) {
    throw new Error(run.error?.message ?? "remote exec failed");
  }
  if (run.resources.length === 0) {
    throw new Error("remote exec returned no result resources");
  }

  return parseRunResult(run.resources[0]);
}

/**
 * Copy a local file to/from the target host through `@swamp/ssh` copy.
 */
export async function runRemoteCopy(
  ctx: RemoteContext,
  definition: string,
  host: string,
  options: {
    src: string;
    dst: string;
    direction: "to" | "from";
    recursive?: boolean;
    useRsync?: boolean;
    timeoutSec?: number;
  },
): Promise<RemoteRunResult> {
  const runModel = assertRunModel(ctx);

  const args: Record<string, unknown> = {
    hosts: host,
    src: options.src,
    dst: options.dst,
    direction: options.direction,
  };
  if (options.recursive) args.recursive = true;
  if (options.useRsync) args.useRsync = true;
  if (options.timeoutSec !== undefined) args.timeoutSec = options.timeoutSec;

  const run = await runModel({
    definition,
    method: "copy",
    arguments: args,
  });

  if (!run.ok) {
    throw new Error(run.error?.message ?? "remote copy failed");
  }
  if (run.resources.length === 0) {
    throw new Error("remote copy returned no result resources");
  }

  return parseRunResult(run.resources[0]);
}

/** Discover the remote user's home directory. */
export async function discoverHome(
  ctx: RemoteContext,
  definition: string,
  host: string,
  timeoutSec: number,
): Promise<string> {
  const result = await runRemoteExec(ctx, definition, host, {
    command: "echo $HOME",
    timeoutSec,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to discover remote HOME: ${result.stderr}`);
  }
  const home = result.stdout.trim();
  if (!home) {
    throw new Error("Remote HOME is empty");
  }
  return home;
}

/** Ensure a remote directory exists. */
export async function ensureDir(
  ctx: RemoteContext,
  definition: string,
  host: string,
  dir: string,
  userMode: "system" | "user",
  sudo: boolean,
  timeoutSec: number,
): Promise<void> {
  const result = await runRemoteExec(ctx, definition, host, {
    command: `mkdir -p ${shlexQuote(dir)}`,
    sudo: usesSudo(userMode, sudo),
    timeoutSec,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create directory ${dir}: ${result.stderr}`);
  }
}

/**
 * Upload literal file content to a remote path.
 *
 * For system-mode targets that may require root to write into `/etc`, the
 * content is staged under `/tmp` and moved into place with sudo. User-mode
 * targets are written directly.
 */
export async function uploadFile(
  ctx: RemoteContext,
  definition: string,
  host: string,
  remotePath: string,
  content: string,
  userMode: "system" | "user",
  sudo: boolean,
  timeoutSec: number,
): Promise<void> {
  const fileName = remotePath.split("/").pop() ?? "unit";

  if (userMode === "system") {
    const stagingDir = `/tmp/swamp-systemd-${crypto.randomUUID()}`;
    const stagingPath = `${stagingDir}/${fileName}`;

    await runRemoteExec(ctx, definition, host, {
      command: `mkdir -p ${shlexQuote(stagingDir)}`,
      timeoutSec,
    });

    const localTemp = await Deno.makeTempFile({ prefix: "swamp-systemd-" });
    try {
      await Deno.writeTextFile(localTemp, content);
      const copyResult = await runRemoteCopy(ctx, definition, host, {
        src: localTemp,
        dst: stagingPath,
        direction: "to",
        timeoutSec,
      });
      if (copyResult.exitCode !== 0) {
        throw new Error(
          `Failed to stage file to ${stagingPath}: ${copyResult.stderr}`,
        );
      }
    } finally {
      try {
        await Deno.remove(localTemp);
      } catch {
        // best-effort cleanup
      }
    }

    const sudoFlag = usesSudo(userMode, sudo);
    let result = await runRemoteExec(ctx, definition, host, {
      command: `mv ${shlexQuote(stagingPath)} ${shlexQuote(remotePath)}`,
      sudo: sudoFlag,
      timeoutSec,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to move staged file to ${remotePath}: ${result.stderr}`,
      );
    }

    result = await runRemoteExec(ctx, definition, host, {
      command: `chmod 644 ${shlexQuote(remotePath)}`,
      sudo: sudoFlag,
      timeoutSec,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to chmod ${remotePath}: ${result.stderr}`);
    }

    await runRemoteExec(ctx, definition, host, {
      command: `rm -rf ${shlexQuote(stagingDir)}`,
      timeoutSec,
    });
  } else {
    const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
    await ensureDir(ctx, definition, host, dir, userMode, sudo, timeoutSec);

    const localTemp = await Deno.makeTempFile({ prefix: "swamp-systemd-" });
    try {
      await Deno.writeTextFile(localTemp, content);
      const copyResult = await runRemoteCopy(ctx, definition, host, {
        src: localTemp,
        dst: remotePath,
        direction: "to",
        timeoutSec,
      });
      if (copyResult.exitCode !== 0) {
        throw new Error(
          `Failed to upload file to ${remotePath}: ${copyResult.stderr}`,
        );
      }
    } finally {
      try {
        await Deno.remove(localTemp);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** Run systemctl on the target host. */
export function execSystemctl(
  ctx: RemoteContext,
  definition: string,
  host: string,
  userMode: "system" | "user",
  sudo: boolean,
  subcommand: string[],
  timeoutSec: number,
): Promise<RemoteRunResult> {
  const parts = ["systemctl"];
  if (userMode === "user") {
    parts.push("--user");
  }
  parts.push(...subcommand);

  return runRemoteExec(ctx, definition, host, {
    command: parts.map(shlexQuote).join(" "),
    sudo: usesSudo(userMode, sudo),
    timeoutSec,
  });
}
