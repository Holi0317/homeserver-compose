// deno-lint-ignore-file no-import-prefix
import * as z from "npm:zod@4";
import { removeTrackedFiles, uploadManagedFile } from "./files.ts";
import { readinessGate } from "./readiness.ts";
import {
  type ApplyArgs,
  ApplyArgsSchema,
  type DestroyArgs,
  DestroyArgsSchema,
  ReadinessSchema,
  type RunResultSchema,
} from "./schemas.ts";
import { execSystemctl, systemctlShow } from "./systemctl.ts";
import type {
  CommandResult,
  FileRecord,
  GlobalArgs,
  ManagedState,
  MethodContext,
  ResourceTarget,
  SystemdOperations,
} from "./types.ts";

function resultData(
  method: string,
  ga: GlobalArgs,
  result: CommandResult,
  extra: Record<string, unknown> = {},
): z.infer<typeof RunResultSchema> {
  return {
    method,
    host: ga.remote.host,
    unitName: ga.unitName,
    changed: result.exitCode === 0,
    success: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

async function readLifecycleState<State extends ManagedState>(
  operations: SystemdOperations<State>,
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<{ enabled: boolean; active: boolean }> {
  const runtimeName = operations.runtimeName(ga.unitName);
  const enabledResult = await execSystemctl(
    ctx,
    ga,
    ["is-enabled", runtimeName],
    [0, 1, 3],
  );
  const activeResult = await execSystemctl(
    ctx,
    ga,
    ["is-active", runtimeName],
    [0, 3],
  );
  return {
    enabled: enabledResult.exitCode === 0,
    active: activeResult.stdout.trim() === "active",
  };
}

async function applyDesired<State extends ManagedState>(
  operations: SystemdOperations<State>,
  args: ApplyArgs,
  ctx: MethodContext,
  ga: GlobalArgs,
  previousState?: State,
): Promise<{
  result: CommandResult;
  files: FileRecord[];
  wantedBy: string[];
  lifecycle: { enabled: boolean; active: boolean };
  changed: boolean;
}> {
  const dir = await operations.targetDirectory(ctx, ga);
  const files: FileRecord[] = [];
  const wantedBy = operations.wantedBy(ga.content, previousState);
  let result: CommandResult = { stdout: "", stderr: "", exitCode: 0 };
  let changed = false;

  if (ga.content !== undefined) {
    files.push(await uploadManagedFile(ctx, ga, dir));
    result = await execSystemctl(ctx, ga, ["daemon-reload"]);
    if (result.exitCode !== 0) {
      throw new Error(`daemon-reload failed: ${result.stderr}`);
    }
    changed = true;
  }

  const runtimeName = operations.runtimeName(ga.unitName);
  if (ga.enabled !== undefined) {
    result = await operations.setEnablement(
      ctx,
      ga,
      runtimeName,
      wantedBy,
      ga.enabled,
    );
    changed = true;
  }

  if (ga.state !== undefined) {
    const action = ga.state === "running" ? "start" : "stop";
    result = await execSystemctl(ctx, ga, [action, runtimeName]);
    if (result.exitCode !== 0) {
      throw new Error(`${action} ${ga.unitName} failed: ${result.stderr}`);
    }
    changed = true;
  }

  if (args.readiness && ga.state === "running") {
    await readinessGate(args.readiness, ctx, ga);
  }

  const lifecycle = await readLifecycleState(operations, ctx, ga);
  return { result, files, wantedBy, lifecycle, changed };
}

async function destroyManagedState<State extends ManagedState>(
  operations: SystemdOperations<State>,
  state: State,
  args: DestroyArgs,
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<CommandResult> {
  const oldName = operations.stateName(state);
  const runtimeName = operations.runtimeName(oldName);
  let result = await execSystemctl(ctx, ga, ["stop", runtimeName]);
  if (result.exitCode !== 0) {
    throw new Error(`stop ${oldName} failed: ${result.stderr}`);
  }
  result = await execSystemctl(ctx, ga, ["disable", runtimeName]);
  if (result.exitCode !== 0) {
    throw new Error(`disable ${oldName} failed: ${result.stderr}`);
  }

  const enablementResult = await operations.removeEnablement(
    ctx,
    ga,
    runtimeName,
    operations.enablementTargets(state),
  );
  if (enablementResult) result = enablementResult;

  if (args.removeFiles) {
    const fileResult = await removeTrackedFiles(ctx, ga, state.files);
    if (fileResult) result = fileResult;
  }

  if (
    operations.reloadAfterDestroy ||
    (args.removeFiles && state.files.length > 0)
  ) {
    result = await execSystemctl(ctx, ga, ["daemon-reload"]);
    if (result.exitCode !== 0) {
      throw new Error(`daemon-reload failed: ${result.stderr}`);
    }
  }
  return result;
}

function targetFromArgs(ga: GlobalArgs): ResourceTarget {
  return {
    userMode: ga.userMode,
    fleet: ga.remote.fleet,
    host: ga.remote.host,
    unitName: ga.unitName,
  };
}

export function createSystemdMethods<State extends ManagedState>(
  operations: SystemdOperations<State>,
) {
  return {
    check: {
      description: "Observe the managed unit without mutation",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const result = await systemctlShow(
          context,
          ga,
          operations.runtimeName(ga.unitName),
        );
        const handle = await context.writeResource(
          "runResult",
          "check",
          resultData("check", ga, result, { changed: false }),
        );
        return { dataHandles: [handle] };
      },
    },
    apply: {
      description:
        "Converge the resource, requiring explicit consent for replacement",
      arguments: ApplyArgsSchema,
      execute: async (
        args: ApplyArgs,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const parsedState = operations.stateSchema.safeParse(
          await context.readResource("current"),
        );
        const storedData = parsedState.success ? parsedState.data : undefined;
        const oldIdentity = storedData
          ? operations.identityForState(storedData)
          : undefined;
        const newIdentity = operations.identityForTarget(targetFromArgs(ga));
        const replacement = oldIdentity !== undefined &&
          oldIdentity !== newIdentity;
        if (replacement && !args.allowRecreate) {
          const diagnostic = await context.writeResource(
            "runResult",
            "apply",
            resultData(
              "apply",
              ga,
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
            const destroyArgs: GlobalArgs = {
              ...ga,
              userMode: storedData.userMode,
              remote: {
                fleet: storedData.fleet ?? ga.remote.fleet,
                host: storedData.host,
                sudo: storedData.sudo ?? ga.remote.sudo,
              },
            };
            await destroyManagedState(
              operations,
              storedData,
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
            operations,
            args,
            context,
            ga,
            storedData,
          );
          const files = applied.files.length > 0
            ? applied.files
            : preservedFiles;
          const state = operations.buildState(
            ga,
            files,
            applied.wantedBy,
            applied.lifecycle,
          );
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
                { stdout: "", stderr: "", exitCode: null },
                {
                  success: false,
                  changed: true,
                  replacementRequired: true,
                  recreated,
                  oldIdentity,
                  newIdentity,
                  error: error instanceof Error ? error.message : String(error),
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
          ga,
          ["start", operations.runtimeName(ga.unitName)],
        );
        if (result.exitCode !== 0) {
          throw new Error(`start ${ga.unitName} failed: ${result.stderr}`);
        }
        if (args.readiness) await readinessGate(args.readiness, context, ga);
        const handle = await context.writeResource(
          "runResult",
          "start",
          resultData("start", ga, result),
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
          ga,
          ["stop", operations.runtimeName(ga.unitName)],
        );
        if (result.exitCode !== 0) {
          throw new Error(`stop ${ga.unitName} failed: ${result.stderr}`);
        }
        const handle = await context.writeResource(
          "runResult",
          "stop",
          resultData("stop", ga, result),
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
          ga,
          ["restart", operations.runtimeName(ga.unitName)],
        );
        if (result.exitCode !== 0) {
          throw new Error(`restart ${ga.unitName} failed: ${result.stderr}`);
        }
        const handle = await context.writeResource(
          "runResult",
          "restart",
          resultData("restart", ga, result),
        );
        return { dataHandles: [handle] };
      },
    },
    reload: {
      description: "Reload the managed systemd unit",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const result = await execSystemctl(
          context,
          ga,
          ["reload", operations.runtimeName(ga.unitName)],
        );
        if (result.exitCode !== 0) {
          throw new Error(`reload ${ga.unitName} failed: ${result.stderr}`);
        }
        const handle = await context.writeResource(
          "runResult",
          "reload",
          resultData("reload", ga, result),
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
        const result = await systemctlShow(
          context,
          ga,
          operations.runtimeName(ga.unitName),
        );
        const handle = await context.writeResource(
          "runResult",
          "status",
          resultData("status", ga, result, { changed: false }),
        );
        return { dataHandles: [handle] };
      },
    },
    destroy: {
      description: "Stop, disable, and remove only files tracked by this model",
      arguments: DestroyArgsSchema,
      execute: async (
        args: DestroyArgs,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const parsedState = operations.stateSchema.safeParse(
          await context.readResource("current"),
        );
        const stored = parsedState.success ? parsedState.data : undefined;
        let result: CommandResult = {
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
        if (stored) {
          result = await destroyManagedState(
            operations,
            stored,
            args,
            context,
            ga,
          );
          await context.deleteResource("current");
        }
        const handle = await context.writeResource(
          "runResult",
          "destroy",
          resultData("destroy", ga, result, { changed: stored !== undefined }),
        );
        return { dataHandles: [handle] };
      },
    },
  };
}
