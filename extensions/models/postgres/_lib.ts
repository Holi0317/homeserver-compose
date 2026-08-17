import { z } from "npm:zod@4";
import {
  type RemoteContext,
  runRemoteExec,
  SshRefSchema,
} from "@holi0317/remote-ssh";

export const PostgresTargetSchema = z.object({
  ...SshRefSchema.shape,
  timeoutSeconds: z.number().int().positive().default(300).describe(
    "Per-command timeout passed to @swamp/ssh",
  ),
  containerName: z.string().min(1).default("postgres").describe(
    "Name of the running PostgreSQL container",
  ),
});

export type PostgresTarget = z.infer<typeof PostgresTargetSchema>;

export interface PostgresMethodContext<GlobalArgs extends PostgresTarget>
  extends RemoteContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

export interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Quote a string as a safe single PostgreSQL identifier. */
export function pgIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Quote a string as a safe PostgreSQL string literal. */
export function pgLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Quote a string for safe use as a single literal POSIX shell word. */
export function shlexQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function environmentName(variable: string): string {
  return `SWAMP_${variable.replaceAll(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

/** Build a psql command without embedding sensitive variable values. */
export function psqlCommand(
  containerName: string,
  database: string,
  sql: string,
  options: { tuplesOnly?: boolean; variables?: string[] } = {},
): string {
  const queryOptions = options.tuplesOnly ? " -At" : "";
  const variables = (options.variables ?? [])
    .map((variable) =>
      ` -v ${shlexQuote(variable)}=\"$${environmentName(variable)}\"`
    )
    .join("");
  return `podman exec -i ${shlexQuote(containerName)} psql -U postgres -d ${
    pgIdent(database)
  } -v ON_ERROR_STOP=1${queryOptions}${variables} -c ${shlexQuote(sql)}`;
}
export function parsePgBoolean(value: string): boolean {
  return value === "t" || value === "true";
}

/** Run psql inside the managed PostgreSQL container. */
export async function execPsql(
  ctx: RemoteContext,
  target: PostgresTarget,
  database: string,
  sql: string,
  variables: Record<string, string> = {},
  options: { tuplesOnly?: boolean } = {},
): Promise<RemoteCommandResult> {
  const env = Object.fromEntries(
    Object.entries(variables).map(([name, value]) => [
      environmentName(name),
      value,
    ]),
  );
  const result = await runRemoteExec(ctx, target.sshModel, target.host, {
    command: psqlCommand(target.containerName, database, sql, {
      tuplesOnly: options.tuplesOnly,
      variables: Object.keys(variables),
    }),
    sudo: target.sudo,
    timeoutSec: target.timeoutSeconds,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `PostgreSQL command failed for ${database}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

export function parsePipeRow(stdout: string): string[] | null {
  const row = stdout.trim();
  return row ? row.split("|") : null;
}
