import { z } from "zod";
import {
  type RemoteContext,
  runRemoteExec,
  SshRefSchema,
} from "@holi0317/remote-ssh";

export const ValkeyTargetSchema = z.object({
  ...SshRefSchema.shape,
  timeoutSeconds: z.number().int().positive().default(120).describe(
    "Per-command timeout passed to @swamp/ssh",
  ),
  containerName: z.string().min(1).default("valkey").describe(
    "Name of the running Valkey container",
  ),
});

export type ValkeyTarget = z.infer<typeof ValkeyTargetSchema>;

export interface ValkeyMethodContext<GlobalArgs extends ValkeyTarget>
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

/** Path of the management Unix socket inside the Valkey container. */
export const VALKEY_SOCKET = "/data/valkey.sock";

/** Quote a string for safe use as a single literal POSIX shell word. */
export function shlexQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Hex-encoded SHA-256 digest of a password, for `#<hash>` ACL rules. */
export async function sha256Hex(password: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(password),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Build the valkey-cli invocation run inside the managed container.
 *
 * A single argv word chain — no shell operators — so it survives
 * `sudo -n` wrapping. The command authenticates as the default user over
 * the container-local Unix socket, so no secret crosses the network.
 */
export function valkeyCliCommand(
  containerName: string,
  adminPassword: string,
  args: string[],
): string {
  const words = [
    "podman",
    "exec",
    shlexQuote(containerName),
    "valkey-cli",
    "-s",
    shlexQuote(VALKEY_SOCKET),
    "--no-auth-warning",
    "-a",
    shlexQuote(adminPassword),
    "--raw",
    ...args.map(shlexQuote),
  ];
  return words.join(" ");
}

/** Run an ACL command inside the managed Valkey container.
 *
 * valkey-cli does not always exit non-zero on error replies, so an
 * `(error)` reply on stdout is treated as a failure as well.
 */
export async function execAcl(
  ctx: RemoteContext,
  target: ValkeyTarget,
  adminPassword: string,
  args: string[],
): Promise<RemoteCommandResult> {
  const result = await runRemoteExec(
    ctx,
    target.sshModel,
    target.host,
    {
      command: valkeyCliCommand(target.containerName, adminPassword, args),
      sudo: target.sudo,
      timeoutSec: target.timeoutSeconds,
    },
  );
  const failed = result.exitCode !== 0 ||
    result.stdout.trimStart().startsWith("(error)");
  if (failed) {
    throw new Error(
      `Valkey command failed (${args.join(" ")}): ${
        [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" | ")
      }`,
    );
  }
  return result;
}

export interface AclUser {
  name: string;
  on: boolean;
  nopass: boolean;
  passwordHashes: string[];
  keys: string[];
  channels: string[];
  commands: string[];
  selectors: string[];
}

/** Parse one `ACL LIST` rule line into its structural parts.
 *
 * Tokens are grouped by prefix: flags (`on`, `off`, `nopass`,
 * `sanitize-payload`), passwords (`#hash`), key patterns (`~pat` and
 * `%R~`-style), channel patterns (`&pat`), command rules (`+rule`,
 * `-rule`), and inline selectors (`(...)`).
 */
export function parseAclRule(name: string, line: string): AclUser {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "user" || tokens[1] !== name) {
    throw new Error(`ACL LIST line does not describe user ${name}`);
  }
  const user: AclUser = {
    name,
    on: false,
    nopass: false,
    passwordHashes: [],
    keys: [],
    channels: [],
    commands: [],
    selectors: [],
  };
  for (const token of tokens.slice(2)) {
    if (token === "on") user.on = true;
    else if (token === "off") user.on = false;
    else if (token === "nopass") user.nopass = true;
    else if (token.startsWith("#")) user.passwordHashes.push(token.slice(1));
    else if (token.startsWith("~") || token.startsWith("%")) {
      user.keys.push(token);
    } else if (token.startsWith("&")) user.channels.push(token);
    else if (token.startsWith("+") || token.startsWith("-")) {
      user.commands.push(token);
    } else if (token.startsWith("(")) user.selectors.push(token);
    // Unknown flag words (e.g. sanitize-payload) carry no desired-state
    // meaning for this model and are ignored.
  }
  return user;
}

/** Extract a user rule line from `ACL LIST --raw` output. */
export function parseAclList(stdout: string, name: string): AclUser | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const tokens = trimmed.split(/\s+/);
    if (tokens[0] === "user" && tokens[1] === name) {
      return parseAclRule(name, trimmed);
    }
  }
  return null;
}

function sorted(value: string[]): string[] {
  return [...value].sort();
}

/** Build `ACL SETUSER` directives converging the observed user to the
 * desired state. Returns an empty array when no drift exists.
 */
export function aclSetUserDirectives(
  desired: {
    on: boolean;
    passwordHash: string | null;
    keys: string[];
    channels: string[];
    commands: string[];
  },
  observed: AclUser | null,
): string[] {
  const directives: string[] = [];
  if (observed === null) {
    directives.push(desired.on ? "on" : "off");
    if (desired.passwordHash !== null) {
      directives.push(`#${desired.passwordHash}`);
    } else {
      directives.push("nopass");
    }
    directives.push(...desired.keys, ...desired.channels, ...desired.commands);
    return directives;
  }
  if (observed.on !== desired.on) {
    directives.push(desired.on ? "on" : "off");
  }
  const passwordDrift = desired.passwordHash === null
    ? observed.passwordHashes.length > 0 || observed.nopass !== true
    : observed.nopass === true ||
      !observed.passwordHashes.includes(desired.passwordHash) ||
      observed.passwordHashes.length !== 1;
  if (passwordDrift) {
    directives.push("resetpass");
    if (desired.passwordHash === null) directives.push("nopass");
    else directives.push(`#${desired.passwordHash}`);
  }
  if (sorted(observed.keys).join("|") !== sorted(desired.keys).join("|")) {
    directives.push("resetkeys", ...desired.keys);
  }
  if (
    sorted(observed.channels).join("|") !== sorted(desired.channels).join("|")
  ) {
    directives.push("resetchannels", ...desired.channels);
  }
  if (
    sorted(observed.commands).join("|") !== sorted(desired.commands).join("|")
  ) {
    directives.push("-@all", ...desired.commands);
  }
  if (observed.selectors.length > 0) {
    directives.push("clearselectors");
  }
  return directives;
}
