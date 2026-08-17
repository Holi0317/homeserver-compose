import { z } from "npm:zod@4";
import {
  type RemoteContext,
  runRemoteExec,
  SshRefSchema,
} from "@holi0317/remote-ssh";

const SecretNameSchema = z.string().min(1).max(255).regex(
  /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  "Podman secret names must contain only letters, digits, dots, underscores, and hyphens",
);

const GlobalArgumentsSchema = z.object({
  ...SshRefSchema.shape,
  timeoutSeconds: z.number().int().positive().default(300).describe(
    "Per-command timeout passed to @swamp/ssh",
  ),
  secretName: SecretNameSchema.describe("Podman secret name"),
  value: z.string().min(1).describe(
    "Desired secret value; pass through a vault expression",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;

interface MethodContext extends RemoteContext {
  globalArgs: GlobalArguments;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

const SecretStateSchema = z.object({
  exists: z.boolean(),
  host: z.string(),
  secretName: z.string(),
  valueHash: z.string().length(64).optional(),
  observedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  secretName: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const CheckArgsSchema = z.object({});
const ApplyArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit removing the secret",
  ),
});
const ReplaceArgsSchema = z.object({
  value: z.string().min(1).describe(
    "Replacement value; pass through a vault expression",
  ),
});

type SecretInspection = {
  exists: boolean;
};

async function hashValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function secretName(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function inspectSecret(
  context: MethodContext,
  ga: GlobalArguments,
): Promise<SecretInspection> {
  const result = await runRemoteExec(context, ga.sshModel, ga.host, {
    command: `podman secret inspect ${
      secretName(ga.secretName)
    } >/dev/null 2>&1`,
    sudo: ga.sudo,
    timeoutSec: ga.timeoutSeconds,
    okExitCodes: [0, 125],
  });
  return { exists: result.exitCode === 0 };
}

function createSecretCommand(name: string): string {
  return `set -eu; printf '%s' "$SWAMP_SECRET_VALUE" | podman secret create ${
    secretName(name)
  } -`;
}

function replaceSecretCommand(name: string): string {
  return `set -eu; podman secret rm ${
    secretName(name)
  }; printf '%s' "$SWAMP_SECRET_VALUE" | podman secret create ${
    secretName(name)
  } -`;
}

function state(
  ga: GlobalArguments,
  exists: boolean,
  valueHash?: string,
): Record<string, unknown> {
  return {
    exists,
    host: ga.host,
    secretName: ga.secretName,
    ...(valueHash === undefined ? {} : { valueHash }),
    observedAt: new Date().toISOString(),
  };
}

function writeResult(
  context: MethodContext,
  ga: GlobalArguments,
  method: string,
  changed: boolean,
): Promise<{ name: string }> {
  return context.writeResource("runResult", "last", {
    method,
    host: ga.host,
    secretName: ga.secretName,
    changed,
    success: true,
    timestamp: new Date().toISOString(),
  });
}

function writeState(
  context: MethodContext,
  ga: GlobalArguments,
  exists: boolean,
  valueHash?: string,
): Promise<{ name: string }> {
  return context.writeResource(
    "secret",
    "current",
    state(ga, exists, valueHash),
  );
}

async function writeSecret(
  context: MethodContext,
  ga: GlobalArguments,
  value: string,
  command: string,
): Promise<void> {
  const result = await runRemoteExec(context, ga.sshModel, ga.host, {
    command,
    sudo: ga.sudo,
    timeoutSec: ga.timeoutSeconds,
    env: { SWAMP_SECRET_VALUE: value },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Podman secret operation failed for ${ga.secretName}: ${result.stderr.trim()}`,
    );
  }
}

export const model = {
  type: "@holi0317/podman/secret",
  version: "2026.08.16.1",
  globalArguments: GlobalArgumentsSchema,
  resources: {
    secret: {
      description: "Observed Podman secret state without its value",
      schema: SecretStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a Podman secret method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe whether the Podman secret exists",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const inspection = await inspectSecret(context, ga);
        const previous = await context.readResource("current");
        const stateHandle = await writeState(
          context,
          ga,
          inspection.exists,
          typeof previous?.valueHash === "string"
            ? previous.valueHash
            : undefined,
        );
        const resultHandle = await writeResult(context, ga, "check", false);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description:
        "Create the Podman secret and replace it only when the managed desired value changed",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const desiredHash = await hashValue(ga.value);
        const inspection = await inspectSecret(context, ga);
        const previous = await context.readResource("current");
        const previousHash = typeof previous?.valueHash === "string"
          ? previous.valueHash
          : undefined;
        let changed = false;
        if (!inspection.exists) {
          await writeSecret(
            context,
            ga,
            ga.value,
            createSecretCommand(ga.secretName),
          );
          changed = true;
        } else if (previousHash !== undefined && previousHash !== desiredHash) {
          await writeSecret(
            context,
            ga,
            ga.value,
            replaceSecretCommand(ga.secretName),
          );
          changed = true;
        }
        const stateHandle = await writeState(context, ga, true, desiredHash);
        const resultHandle = await writeResult(context, ga, "apply", changed);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    replace: {
      description:
        "Explicitly replace a Podman secret, failing if a consumer still uses it",
      arguments: ReplaceArgsSchema,
      execute: async (
        args: z.infer<typeof ReplaceArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        await writeSecret(
          context,
          ga,
          args.value,
          replaceSecretCommand(ga.secretName),
        );
        const stateHandle = await writeState(
          context,
          ga,
          true,
          await hashValue(args.value),
        );
        const resultHandle = await writeResult(context, ga, "replace", true);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    destroy: {
      description: "Remove the Podman secret",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying Podman secret ${ga.secretName} requires allowDestroy=true`,
          );
        }
        const inspection = await inspectSecret(context, ga);
        if (inspection.exists) {
          const result = await runRemoteExec(context, ga.sshModel, ga.host, {
            command: `podman secret rm ${secretName(ga.secretName)}`,
            sudo: ga.sudo,
            timeoutSec: ga.timeoutSeconds,
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `Podman secret removal failed for ${ga.secretName}: ${result.stderr.trim()}`,
            );
          }
        }
        const stateHandle = await writeState(context, ga, false);
        const resultHandle = await writeResult(
          context,
          ga,
          "destroy",
          inspection.exists,
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
