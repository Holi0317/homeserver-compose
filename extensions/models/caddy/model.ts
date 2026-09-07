import {
  ApplyArgumentsSchema,
  ConfigGlobalArgumentsSchema,
  DeploymentSchema,
  RenderedConfigSchema,
  ValidateArgumentsSchema,
} from "./schema.ts";
import { renderInventory } from "./render.ts";
import { sha256 } from "./remote.ts";
import { applyExecute } from "./apply.ts";
import type { CaddyMethodContext, CaddyMethodResult } from "./context.ts";

async function renderExecute(
  rawArgs: unknown,
  context: CaddyMethodContext,
): Promise<CaddyMethodResult> {
  ConfigGlobalArgumentsSchema.parse(rawArgs);
  const globalArguments = ConfigGlobalArgumentsSchema.parse(
    context.globalArgs,
  );
  const json = renderInventory(
    globalArguments.inventory,
    globalArguments.dynamicDns,
  );
  const digest = await sha256(json);
  const siteNames = globalArguments.inventory.sites
    .filter((site) =>
      site.enabled &&
      (site.public !== undefined || site.tailnet !== undefined)
    )
    .map((site) => site.name);
  const config = { digest, json, siteNames };
  const digestHandle = await context.writeResource("config", digest, config);
  const currentHandle = await context.writeResource("config", "current", config);
  return { dataHandles: [digestHandle, currentHandle] };
}

async function validateExecute(
  rawArgs: unknown,
  context: CaddyMethodContext,
): Promise<CaddyMethodResult> {
  const args = ValidateArgumentsSchema.parse(rawArgs);
  const resource = await context.readResource(args.configName);
  if (resource === null || typeof resource.json !== "string") {
    throw new Error(
      `Rendered Caddy configuration ${args.configName} was not found`,
    );
  }
  try {
    const parsed = JSON.parse(resource.json);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Caddy configuration must be a JSON object");
    }
  } catch (error) {
    throw new Error(`Rendered Caddy JSON is invalid: ${String(error)}`);
  }
  return { dataHandles: [] };
}

export const model = {
  type: "@holi0317/caddy/config",
  version: "2026.09.05.2",
  globalArguments: ConfigGlobalArgumentsSchema,
  resources: {
    config: {
      description: "Deterministic Caddy JSON rendered from ingress inventory",
      schema: RenderedConfigSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    deployment: {
      description: "Active Caddy configuration deployment state",
      schema: DeploymentSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    render: {
      description: "Render and record deterministic Caddy JSON",
      arguments: ConfigGlobalArgumentsSchema,
      execute: renderExecute,
    },
    validate: {
      description:
        "Validate rendered Caddy JSON syntax before remote deployment",
      arguments: ValidateArgumentsSchema,
      execute: validateExecute,
    },
    apply: {
      description:
        "Validate, atomically activate, reload, and record Caddy config",
      arguments: ApplyArgumentsSchema,
      execute: applyExecute,
    },
  },
};
