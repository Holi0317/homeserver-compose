/**
 * Swamp extension model for managing a single logical PostgreSQL database
 * inside a running Podman container.
 *
 * One model instance maps to exactly one logical database. The model connects
 * to the host via `@swamp/ssh`, runs DDL through `podman exec postgres psql`,
 * and keeps the application password in a Podman secret so app containers can
 * consume it with `Secret=<name>` instead of exposing it in environment
 * variables.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { runRemoteExec, type RemoteContext, SshRefSchema } from "./_lib/ssh.ts";

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const GlobalArgsSchema = z.object({
  ...SshRefSchema.shape,
  timeoutSeconds: z.number().int().positive().default(300)
    .describe("Per-command timeout passed to @swamp/ssh"),
  containerName: z.string().min(1).default("postgres")
    .describe("Name of the running Postgres container"),
  database: z.string().min(1)
    .describe("Logical database name to create"),
  username: z.string().min(1)
    .describe("Role/username to create and grant access"),
  password: z.string().min(1)
    .describe("Password for the role; pass via vault expression"),
  podmanSecretName: z.string().min(1)
    .describe("Name of the Podman secret to create/update with the password"),
});

const ProvisionArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  removeSecret: z.boolean().default(true)
    .describe("Remove the Podman secret when destroying the database"),
});
const RotatePasswordArgsSchema = z.object({
  newPassword: z.string().min(1)
    .describe("New password for the role; pass via vault expression"),
});

const DatabaseResourceSchema = z.object({
  host: z.string(),
  containerName: z.string(),
  database: z.string(),
  username: z.string(),
  podmanSecretName: z.string(),
  provisionedAt: z.string().datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  database: z.string(),
  username: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  timestamp: z.string().datetime(),
});

interface MethodContext extends RemoteContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Quote a string for safe use as a single literal word in a POSIX shell. */
function shlexQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build the psql command prefix for the target container. */
function psqlCommand(containerName: string, sql: string): string {
  return `podman exec -i ${shlexQuote(containerName)} psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c ${shlexQuote(sql)}`;
}

/** Run psql on the remote host and throw on non-zero exit. */
async function execPsql(
  ctx: MethodContext,
  sql: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const ga = ctx.globalArgs;
  const result = await runRemoteExec(ctx, ga.sshModel, ga.host, {
    command: psqlCommand(ga.containerName, sql),
    sudo: ga.sudo,
    timeoutSec: ga.timeoutSeconds,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `psql failed for database ${ga.database}: ${result.stderr}`,
    );
  }
  return result;
}

/** Run an arbitrary shell command on the remote host and throw on failure. */
async function execShell(
  ctx: MethodContext,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const ga = ctx.globalArgs;
  const result = await runRemoteExec(ctx, ga.sshModel, ga.host, {
    command,
    sudo: ga.sudo,
    timeoutSec: ga.timeoutSeconds,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `remote command failed for database ${ga.database}: ${result.stderr}`,
    );
  }
  return result;
}

/** Escape a string literal for use inside a PostgreSQL string. */
function pgEscape(value: string): string {
  return value.replaceAll("'", "''");
}

/** Quote a PostgreSQL identifier, doubling internal double quotes. */
function pgIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Build SQL to ensure the role exists with the given password. */
function ensureRoleSql(username: string, password: string): string {
  return `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${pgIdent(username)}) THEN
    CREATE ROLE ${pgIdent(username)} WITH LOGIN PASSWORD '${pgEscape(password)}';
  ELSE
    ALTER ROLE ${pgIdent(username)} WITH PASSWORD '${pgEscape(password)}';
  END IF;
END
$$;`;
}

/** Build SQL to ensure the database exists with the correct owner. */
function ensureDatabaseSql(database: string, owner: string): string {
  return `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_database WHERE datname = ${pgIdent(database)}) THEN
    CREATE DATABASE ${pgIdent(database)} OWNER ${pgIdent(owner)} ENCODING 'UTF8' LC_COLLATE 'en_US.UTF8' LC_CTYPE 'en_US.UTF8' TEMPLATE template0;
  END IF;
END
$$;`;
}

/** Build SQL to grant privileges on the database to the role. */
function grantSql(database: string, username: string): string {
  return `GRANT ALL PRIVILEGES ON DATABASE ${pgIdent(database)} TO ${pgIdent(username)};`;
}

/** Build SQL to drop the database and role. */
function dropSql(database: string, username: string): string {
  return `DROP DATABASE IF EXISTS ${pgIdent(database)}; DROP ROLE IF EXISTS ${pgIdent(username)};`;
}

/** Build SQL to rotate the role password. */
function rotatePasswordSql(username: string, password: string): string {
  return `ALTER ROLE ${pgIdent(username)} WITH PASSWORD '${pgEscape(password)}';`;
}

/**
 * Build a shell command that ensures a Podman secret exists with the given
 * value. Podman has no update command, so we remove and recreate.
 */
function ensurePodmanSecretCommand(name: string, value: string): string {
  const quotedName = shlexQuote(name);
  const quotedValue = shlexQuote(value);
  return `podman secret exists ${quotedName} && podman secret rm ${quotedName} || true
printf '%s' ${quotedValue} | podman secret create ${quotedName} -`;
}

/** Build a shell command to remove a Podman secret if it exists. */
function removePodmanSecretCommand(name: string): string {
  return `podman secret exists ${shlexQuote(name)} && podman secret rm ${shlexQuote(name)} || true`;
}

function buildRunResult(
  method: string,
  ga: GlobalArgs,
  result: { stdout: string; stderr: string; exitCode: number | null },
  changed: boolean,
): z.infer<typeof RunResultSchema> {
  return {
    method,
    host: ga.host,
    database: ga.database,
    username: ga.username,
    changed,
    success: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timestamp: new Date().toISOString(),
  };
}

/** Swamp extension model for provisioning a logical PostgreSQL database. */
export const model = {
  type: "@holi0317/postgres",
  version: "2026.08.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    database: {
      description: "Desired and actual state of the logical database",
      schema: DatabaseResourceSchema,
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
    provision: {
      description: "Idempotently create the database, role, grants, and Podman secret",
      arguments: ProvisionArgsSchema,
      execute: async (
        _args: z.infer<typeof ProvisionArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;

        const roleResult = await execPsql(context, ensureRoleSql(ga.username, ga.password));
        const dbResult = await execPsql(context, ensureDatabaseSql(ga.database, ga.username));
        const grantResult = await execPsql(context, grantSql(ga.database, ga.username));
        const secretResult = await execShell(
          context,
          ensurePodmanSecretCommand(ga.podmanSecretName, ga.password),
        );

        const dbHandle = await context.writeResource("database", "current", {
          host: ga.host,
          containerName: ga.containerName,
          database: ga.database,
          username: ga.username,
          podmanSecretName: ga.podmanSecretName,
          provisionedAt: new Date().toISOString(),
        });

        const runHandle = await context.writeResource(
          "runResult",
          "provision",
          buildRunResult("provision", ga, secretResult, true),
        );

        return { dataHandles: [dbHandle, runHandle] };
      },
    },

    destroy: {
      description: "Drop the database and role, and optionally remove the Podman secret",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;

        const dropResult = await execPsql(context, dropSql(ga.database, ga.username));

        if (args.removeSecret) {
          await execShell(context, removePodmanSecretCommand(ga.podmanSecretName));
        }

        const runHandle = await context.writeResource(
          "runResult",
          "destroy",
          buildRunResult("destroy", ga, dropResult, true),
        );

        return { dataHandles: [runHandle] };
      },
    },

    rotate_password: {
      description: "Rotate the role password and update the Podman secret",
      arguments: RotatePasswordArgsSchema,
      execute: async (
        args: z.infer<typeof RotatePasswordArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;

        const sqlResult = await execPsql(
          context,
          rotatePasswordSql(ga.username, args.newPassword),
        );
        const secretResult = await execShell(
          context,
          ensurePodmanSecretCommand(ga.podmanSecretName, args.newPassword),
        );

        const runHandle = await context.writeResource(
          "runResult",
          "rotate_password",
          buildRunResult("rotate_password", ga, secretResult, true),
        );

        return { dataHandles: [runHandle] };
      },
    },
  },
};
