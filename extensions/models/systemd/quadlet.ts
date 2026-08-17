// deno-lint-ignore-file no-import-prefix
import * as z from "npm:zod@4";
import { runRemoteExec, shlexQuote, usesSudo } from "@holi0317/remote-ssh";
import { createSystemdMethods } from "./_lib/methods.ts";
import {
  createGlobalArgumentsSchema,
  FileRecordSchema,
  RunResultSchema,
} from "./_lib/schemas.ts";
import {
  QUADLET_DIRECTORIES,
  RAW_SYSTEMD_DIRECTORIES,
  systemdTargetDirectory,
} from "./_lib/paths.ts";
import { assertSafeUnitName } from "./_lib/validation.ts";
import type {
  CommandResult,
  GlobalArgs,
  MethodContext,
  ResourceTarget,
} from "./_lib/types.ts";

export const QUADLET_EXTENSIONS = [
  ".container",
  ".volume",
  ".network",
  ".pod",
  ".image",
  ".build",
] as const;

export const QuadletGlobalArgumentsSchema = createGlobalArgumentsSchema(
  QUADLET_EXTENSIONS,
  "Quadlet",
  "Optional literal Quadlet source contents",
);

export const QuadletStateSchema = z.object({
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

export type QuadletState = z.infer<typeof QuadletStateSchema>;

export function systemdUnitName(sourceName: string): string {
  if (sourceName.endsWith(".container")) {
    return `${sourceName.slice(0, -10)}.service`;
  }
  for (const extension of QUADLET_EXTENSIONS) {
    if (extension !== ".container" && sourceName.endsWith(extension)) {
      return `${sourceName.slice(0, -extension.length)}-${
        extension.slice(
          1,
        )
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

async function setQuadletEnablement(
  ctx: MethodContext,
  ga: GlobalArgs,
  generatedName: string,
  targets: string[],
  enabled: boolean,
): Promise<CommandResult> {
  const homeBase = (
    await systemdTargetDirectory(ctx, ga, RAW_SYSTEMD_DIRECTORIES)
  ).replace(/\/$/, "");
  const needsSudo = usesSudo(ga.userMode, ga.remote.sudo);
  const commands = targets
    .map((target) => {
      const wantsDir = `${homeBase}/${target}.wants`;
      const link = `${wantsDir}/${generatedName}`;
      const inner = enabled
        ? `sourcePrefix=${
          ga.userMode === "user"
            ? "/run/user/$(id -u)/systemd/generator"
            : "/run/systemd/generator"
        } && mkdir -p ${shlexQuote(wantsDir)} && ln -sf "$sourcePrefix"/${
          shlexQuote(
            generatedName,
          )
        } ${shlexQuote(link)}`
        : `rm -f ${shlexQuote(link)}`;
      return needsSudo ? `sudo -n -- sh -c ${shlexQuote(inner)}` : inner;
    })
    .join(" && ");
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

async function removeQuadletEnablement(
  ctx: MethodContext,
  ga: GlobalArgs,
  generatedName: string,
  targets: string[],
): Promise<CommandResult | undefined> {
  const wantsBase = (
    await systemdTargetDirectory(ctx, ga, RAW_SYSTEMD_DIRECTORIES)
  ).replace(/\/$/, "");
  let result: CommandResult | undefined;
  for (const target of targets) {
    assertSafeUnitName(target, "Stored WantedBy target");
    const removed = await runRemoteExec(ctx, ga.remote.fleet, ga.remote.host, {
      command: `rm -f ${
        shlexQuote(
          `${wantsBase}/${target}.wants/${generatedName}`,
        )
      }`,
      sudo: ga.userMode === "system" && ga.remote.sudo,
      timeoutSec: ga.timeoutSeconds,
    });
    if (removed.exitCode !== 0) {
      throw new Error(
        `Failed to remove Quadlet enablement link for ${ga.unitName}: ${removed.stderr}`,
      );
    }
    result = removed;
  }
  return result;
}

function identityForTarget(target: ResourceTarget): string {
  return `quadlet:${target.fleet}:${target.host}:${target.userMode}:${target.unitName}`;
}

/** Model for one Podman Quadlet source file and generated unit. */
export const model = {
  type: "@holi0317/systemd/quadlet",
  version: "2026.08.16.2",
  globalArguments: QuadletGlobalArgumentsSchema,
  resources: {
    unit: {
      description: "Managed Quadlet source and generated unit state",
      schema: QuadletStateSchema,
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
  methods: createSystemdMethods({
    stateSchema: QuadletStateSchema,
    targetDirectory: (ctx, ga) =>
      systemdTargetDirectory(ctx, ga, QUADLET_DIRECTORIES),
    runtimeName: systemdUnitName,
    stateName: (state) => {
      const name = state.sourceName;
      assertSafeUnitName(name, "Stored unit name");
      return name;
    },
    identityForTarget,
    identityForState: (state) =>
      `quadlet:${
        state.fleet ?? "<unknown>"
      }:${state.host}:${state.userMode}:${state.sourceName}`,
    wantedBy: (content, previousState) => {
      if (content !== undefined) return wantedByTargets(content);
      return previousState?.wantedBy ?? ["default.target"];
    },
    enablementTargets: (state) => {
      const targets = state.wantedBy ?? ["default.target"];
      for (const target of targets) {
        assertSafeUnitName(target, "Stored WantedBy target");
      }
      return targets;
    },
    setEnablement: setQuadletEnablement,
    removeEnablement: removeQuadletEnablement,
    reloadAfterDestroy: true,
    buildState: (ga, files, wantedBy, lifecycle) => ({
      userMode: ga.userMode,
      fleet: ga.remote.fleet,
      host: ga.remote.host,
      sudo: ga.remote.sudo,
      sourceName: ga.unitName,
      generatedUnitName: systemdUnitName(ga.unitName),
      wantedBy,
      files,
      enabled: lifecycle.enabled,
      active: lifecycle.active,
      deployedAt: new Date().toISOString(),
    }),
  }),
};
