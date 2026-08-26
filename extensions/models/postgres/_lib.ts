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


/** Build the psql invocation run inside the managed container.
 *
 * A single argv word chain — no shell operators — so it survives
 * `sudo -n` wrapping without a rootless-podman fallback. SQL arrives via
 * stdin, which works on every transport (tailscale ssh has no SendEnv)
 * and avoids shell quoting entirely.
 */
export function psqlCommand(
  containerName: string,
  database: string,
): string {
  return `podman exec -i ${shlexQuote(containerName)} psql -U postgres -d ${
    pgIdent(database)
  }`;
}

const SCRAM_ITERATIONS = 4096;

function b64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text);
}
async function hmac(key: ArrayBuffer, label: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(label),
  );
}

/** Compute a PostgreSQL SCRAM-SHA-256 password verifier (pg_authid format).
 *
 * Per RFC 7677 and the pg_authid docs:
 *   SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, iterations)
 *   StoredKey      = SHA-256(HMAC(SaltedPassword, "Client Key"))
 *   ServerKey      = HMAC(SaltedPassword, "Server Key")
 *
 * The verifier is not a secret — it is what the server stores — so it can
 * travel through ordinary SQL literals. Computed locally so no plaintext
 * password ever reaches the remote host.
 */
export async function scramSha256Verifier(
  password: string,
  saltInput?: Uint8Array,
): Promise<string> {
  const source = saltInput ?? crypto.getRandomValues(new Uint8Array(16));
  const salt = source.slice().buffer as ArrayBuffer;
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const saltedPassword = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: SCRAM_ITERATIONS,
    },
    passwordKey,
    256,
  );
  const clientKey = await hmac(saltedPassword, "Client Key");
  const storedKey = await crypto.subtle.digest("SHA-256", clientKey);
  const serverKey = await hmac(saltedPassword, "Server Key");
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
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
  options: { tuplesOnly?: boolean } = {},
): Promise<RemoteCommandResult> {
  const flags = options.tuplesOnly ? " -At" : "";
  const result = await runRemoteExec(ctx, target.sshModel, target.host, {
    command: psqlCommand(target.containerName, database) + flags + " -v ON_ERROR_STOP=1",
    sudo: target.sudo,
    timeoutSec: target.timeoutSeconds,
    stdin: `${sql}\n`,
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
