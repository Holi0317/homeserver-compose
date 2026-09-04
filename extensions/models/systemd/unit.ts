// deno-lint-ignore-file no-import-prefix
import * as z from "npm:zod@4";
import { createSystemdMethods } from "./_lib/methods.ts";
import {
  createGlobalArgumentsSchema,
  FileRecordSchema,
  RunResultSchema,
} from "./_lib/schemas.ts";
import {
  RAW_SYSTEMD_DIRECTORIES,
  systemdTargetDirectory,
} from "./_lib/paths.ts";
import { execSystemctl } from "./_lib/systemctl.ts";
import { assertSafeUnitName } from "./_lib/validation.ts";
import type {
  CommandResult,
  GlobalArgs,
  MethodContext,
  ResourceTarget,
} from "./_lib/types.ts";

export const RAW_EXTENSIONS = [
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

export const UnitGlobalArgumentsSchema = createGlobalArgumentsSchema(
  RAW_EXTENSIONS,
  "raw systemd",
  "Optional literal raw systemd unit contents",
);

export const UnitStateSchema = z.object({
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

export type UnitState = z.infer<typeof UnitStateSchema>;

function identityForTarget(target: ResourceTarget): string {
  return `unit:${target.fleet}:${target.host}:${target.userMode}:${target.unitName}`;
}

async function setEnablement(
  ctx: MethodContext,
  ga: GlobalArgs,
  runtimeName: string,
  _targets: string[],
  enabled: boolean,
): Promise<CommandResult> {
  const action = enabled ? "enable" : "disable";
  const result = await execSystemctl(ctx, ga, [action, runtimeName]);
  if (result.exitCode !== 0) {
    throw new Error(`${action} ${ga.unitName} failed: ${result.stderr}`);
  }
  return result;
}

/** Model for one conventional raw systemd unit file. */
export const model = {
  type: "@holi0317/systemd/unit",
  version: "2026.09.04.1",
  globalArguments: UnitGlobalArgumentsSchema,
  resources: {
    unit: {
      description: "Managed raw systemd unit state",
      schema: UnitStateSchema,
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
  methods: createSystemdMethods<UnitState>({
    stateSchema: UnitStateSchema,
    targetDirectory: (ctx, ga) =>
      systemdTargetDirectory(ctx, ga, RAW_SYSTEMD_DIRECTORIES),
    runtimeName: (sourceName) => sourceName,
    stateName: (state) => {
      const name = state.unitName;
      assertSafeUnitName(name, "Stored unit name");
      return name;
    },
    identityForTarget,
    identityForState: (state) =>
      `unit:${
        state.fleet ?? "<unknown>"
      }:${state.host}:${state.userMode}:${state.unitName}`,
    wantedBy: () => [],
    enablementTargets: () => [],
    setEnablement,
    removeEnablement: () => Promise.resolve(undefined),
    reloadAfterDestroy: false,
    buildState: (ga, files, _wantedBy, lifecycle) => ({
      userMode: ga.userMode,
      fleet: ga.remote.fleet,
      host: ga.remote.host,
      sudo: ga.remote.sudo,
      unitName: ga.unitName,
      files,
      enabled: lifecycle.enabled,
      active: lifecycle.active,
      deployedAt: new Date().toISOString(),
    }),
  }),
};
