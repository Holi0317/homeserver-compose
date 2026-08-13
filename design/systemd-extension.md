# Design: `@holi0317/systemd` Swamp extension

> Placeholder collective/name. The real collective must be taken from
> `swamp auth whoami --json` before publishing; the type name should then be
> `@<collective>/systemd`.

## Goals

Manage a single systemd unit on a remote Linux host over SSH or Tailscale SSH.
One swamp model instance maps to exactly one unit. The unit can be:

- Defined inline in the model via `content` (the literal unit file contents).
- Already present on the system, e.g. installed by apt, by omitting `content`.

The extension is idempotent, auditable, and supports both raw systemd units
(e.g. `.service`, `.timer`) and Podman Quadlet units (e.g. `.container`,
`.network`).

Core operations:

- `deploy` – upload the unit file when `content` is given, run
  `daemon-reload`, optionally enable/start, and optionally run a readiness
  gate.
- `start` / `stop` / `restart` – lifecycle operations via `systemctl`.
- `status` – query active/sub/enabled/load state.
- `destroy` – stop/disable, remove tracked uploaded files, reload.

## Research notes

### `@swamp/ssh`

`swamp extension info @swamp/ssh --json` shows that `@swamp/ssh` is a **model**
for managing a fleet of hosts. It exposes `apply`, `exec`, `copy`, `script`,
etc., but those are model methods, not a reusable library. A model cannot import
or call another model's methods at runtime; orchestration across models is the
job of a workflow.

`swamp model type describe @swamp/ssh --json` returns "Model type not found"
because the extension is not installed locally. Even if installed, it would only
surface method schemas, not a callable API.

**Decision:** do not take a hard runtime dependency on `@swamp/ssh`. The new
extension will implement the transport directly with `ssh` and `tailscale ssh`,
streaming file contents over stdin to `cat > <remote-path>`. Users who already
use `@swamp/ssh` can still pass a host's `name`/`user` into this model's
`connection` fields via CEL, but the extension works standalone.

### `@keeb/docker`

`swamp extension info @keeb/docker --json` shows a familiar remote-host
pattern:

- `sshHost` and `sshUser` are global arguments.
- Each method shells out to the remote host over SSH.
- Operations are idempotent (e.g., `run` stops an existing container first).

We will follow the same pattern: per-model-instance connection settings and
local `Deno.Command` invocations of `ssh`/`systemctl`.

## Model type decision

**One model type:** `@holi0317/systemd`.

One model instance represents one unit. Both raw systemd and Quadlet units are
driven by `systemctl`; the only difference is the directory the file lands in.
That directory is derived from the unit name extension:

- Quadlet-specific extensions (`.container`, `.volume`, `.network`, `.pod`,
  `.image`, `.build`) go to the Quadlet directory.
- Everything else (`.service`, `.timer`, `.socket`, etc.) goes to the raw
  systemd directory.

`.service` and `.timer` are always treated as raw systemd units. This removes
the need for a `kind` global argument and keeps model definitions concise.

## Global arguments schema

```ts
import { z } from "npm:zod@4";

const ConnectionSchema = z.object({
  host: z.string().min(1).describe("SSH/Tailscale hostname or IP"),
  user: z.string().default("root").describe("Remote user"),
  transport: z.enum(["ssh", "tailscale"]).default("ssh"),
  port: z.number().int().min(1).max(65535).optional()
    .describe("SSH port; only used when transport is ssh"),
  identity: z.string().optional()
    .describe("Local path to an SSH private key; only used when transport is ssh"),
  identityPassphrase: z.string().optional().meta({ sensitive: true })
    .describe("Passphrase for the SSH private key"),
  sudo: z.boolean().default(false)
    .describe("Use sudo for systemctl commands and file moves into system directories"),
  timeoutSeconds: z.number().int().positive().default(300)
    .describe("Default timeout for remote commands"),
});

const GlobalArgsSchema = z.object({
  connection: ConnectionSchema,
  unitName: z.string().min(1).describe(
    "Full systemd unit name, e.g. node-exporter.service",
  ),
  content: z.string().optional().describe(
    "Optional literal unit file contents. When omitted, the unit is assumed to already exist on the system.",
  ),
  userMode: z.enum(["system", "user"]).default("system")
    .describe("Manage system units or rootless user units"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
```

When `content` is omitted, `deploy` only enables/starts the unit. This lets the
same model manage units that were installed by apt or by another mechanism.

## File and unit schemas

```ts
const ReadinessSchema = z.object({
  helperServiceName: z.string().describe("Name of the oneshot helper service"),
  helperServiceContent: z.string().describe(
    "Raw systemd .service contents; should be Type=oneshot with a blocking ExecStart and RemainAfterExit=yes",
  ),
  timeoutSeconds: z.number().int().positive().default(60),
  pollIntervalSeconds: z.number().int().positive().default(2),
});
```

The helper service is always written to the raw systemd directory, never the
Quadlet directory, because it is a plain `Type=oneshot` service.

## Methods

### `deploy`

Upload the unit file when `content` is provided, reload systemd, optionally
enable/start, and optionally run a readiness gate.

```ts
const DeployArgsSchema = z.object({
  enable: z.boolean().default(true),
  start: z.boolean().default(false),
  readiness: ReadinessSchema.optional(),
});
```

Behavior:

1. If `content` is provided, validate that `unitName` ends with a recognized
   extension, resolve the target directory from the unit name, upload the file,
   and run `systemctl daemon-reload`.
2. If `enable` is true, run `systemctl enable <unitName>`.
3. If `start` is true, run `systemctl start <unitName>`.
4. If `readiness` is provided and the unit was started, write the helper
   `.service` to the raw systemd directory, reload, start it, and poll until it
   becomes `active` (success) or `failed`/`inactive` (error).
5. Write the `unit` resource and a `runResult` resource.

Idempotency:

- Upload is idempotent: re-writing the same contents to the same path is a
  no-op at the systemd level.
- `enable` is idempotent via `systemctl enable`.
- `start` is idempotent: starting an already active unit succeeds.

### `start`

```ts
const StartArgsSchema = z.object({
  readiness: ReadinessSchema.optional(),
});
```

Run `systemctl start <unitName>`. Apply readiness gate if provided. Write
`runResult`.

### `stop`

```ts
const StopArgsSchema = z.object({});
```

Run `systemctl stop <unitName>`. `systemctl stop` is idempotent for inactive
units. Write `runResult`.

### `restart`

```ts
const RestartArgsSchema = z.object({});
```

Run `systemctl restart <unitName>`. Write `runResult`.

### `status`

```ts
const StatusArgsSchema = z.object({});
```

Run `systemctl show <unitName> -p ActiveState -p SubState -p UnitFileState -p
LoadState` and write a `runResult`.

### `destroy`

```ts
const DestroyArgsSchema = z.object({
  removeFiles: z.boolean().default(true),
});
```

Behavior:

1. Stop the unit.
2. Disable the unit.
3. If `removeFiles` is true, delete the file(s) recorded in the stored `unit`
   resource (i.e. files previously uploaded by this model instance). For
   system-installed units with no stored files, this step is skipped.
4. Run `systemctl daemon-reload` only if files were removed.
5. Delete the stored `unit` resource if it exists and write `runResult`.

This allows `destroy` to be used on units that were not deployed by swamp
(e.g. apt-installed packages) without erroring.

## Resources

```ts
const FileRecordSchema = z.object({
  remoteName: z.string(),
  targetDir: z.string(),
  sha256: z.string(),
});

const UnitResourceSchema = z.object({
  kind: z.enum(["service", "quadlet"]),
  userMode: z.enum(["system", "user"]),
  host: z.string(),
  user: z.string(),
  unitName: z.string(),
  files: z.array(FileRecordSchema),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  deployedAt: z.string().datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  unitName: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().optional(),
  timestamp: z.string().datetime(),
});

const resources = {
  unit: {
    description: "Desired and actual state of the managed systemd unit",
    schema: UnitResourceSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  runResult: {
    description: "Outcome of a method invocation",
    schema: RunResultSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
};
```

## File upload behavior

### Target directories

The target directory is derived from the unit name extension and `userMode`:

| Unit extension                              | `userMode` | Target directory                |
|---------------------------------------------|------------|---------------------------------|
| `.container`, `.volume`, `.network`, etc.   | system     | `/etc/containers/systemd/`      |
| `.container`, `.volume`, `.network`, etc.   | user       | `~/.config/containers/systemd/` |
| `.service`, `.timer`, `.socket`, etc.       | system     | `/etc/systemd/system/`          |
| `.service`, `.timer`, `.socket`, etc.       | user       | `~/.config/systemd/user/`       |

For user mode the remote `$HOME` is discovered with a single `echo` command
before uploading.

### Staging directories

System-mode uploads stage files under `/tmp/swamp-systemd-<uuid>/` and then
move them into the target system directory with `sudo mv` when a non-root user
is used. User-mode files are written directly into the user config directory.

### Transport details

- **`ssh` transport:**
  - Commands: `ssh [ -i identity ] [ -p port ] user@host <command>`.
  - File copy: stream the file through `ssh [ -i identity ] [ -p port ] user@host "cat > <remote-path>"`.
  - For system directories with a non-root user, stage to `/tmp` and then
    `sudo mv`/`sudo chmod` into `/etc/...`.

- **`tailscale` transport:**
  - Commands: `tailscale ssh user@host <command>`.
  - File copy: stream the file through `tailscale ssh user@host "cat > <remote-path>"`.

## Connection schema summary

```ts
const ConnectionSchema = z.object({
  host: z.string().min(1),
  user: z.string().default("root"),
  transport: z.enum(["ssh", "tailscale"]).default("ssh"),
  port: z.number().int().min(1).max(65535).optional(),
  identity: z.string().optional(),
  identityPassphrase: z.string().optional().meta({ sensitive: true }),
  sudo: z.boolean().default(false),
  timeoutSeconds: z.number().int().positive().default(300),
});
```

- `transport: "tailscale"` uses the local `tailscale` CLI. No SSH key is
  required; authentication is handled by tailnet identity.
- `transport: "ssh"` uses the local `ssh` binary. If `identity` is omitted,
  the user's SSH agent and `~/.ssh/config` are used.

## Example model definition

```yaml
# models/node-exporter.yaml
type: "@holi0317/systemd"
name: node-exporter
globalArguments:
  connection:
    host: server.tail1234.ts.net
    user: root
    transport: tailscale
  unitName: node-exporter.service
  # content omitted: unit is installed by apt
methods:
  deploy:
    arguments:
      enable: true
      start: true
```

```bash
swamp model method run node-exporter deploy
swamp model method run node-exporter status
swamp model method run node-exporter destroy
```

## Example inline unit

```yaml
# models/caddy.yaml
type: "@holi0317/systemd"
name: caddy
globalArguments:
  connection:
    host: server.tail1234.ts.net
    user: root
    transport: tailscale
  unitName: caddy.service
  content: |
    [Unit]
    Description=Caddy reverse proxy
    After=network.target

    [Service]
    ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
    Restart=always

    [Install]
    WantedBy=multi-user.target
methods:
  deploy:
    arguments:
      enable: true
      start: true
```

## Extension manifest skeleton

```yaml
manifestVersion: 1
name: "@holi0317/systemd"
version: "2026.08.12.2"
description: "Deploy and manage a single systemd unit over SSH"
repository: https://github.com/holi0317/swamp-systemd

models:
  - mod.ts

paths:
  base: manifest

additionalFiles:
  - README.md
  - LICENSE

platforms: []
```

## Open questions

1. **Pre-flight validation.** Should `deploy` run `systemd-analyze verify`
   locally on the rendered unit file before uploading? This would catch syntax
   errors early but adds a host-side dependency.

2. **Privilege escalation beyond sudo.** Some hosts use `doas` or `su`. Should
   the connection schema support an `escalation: "sudo" | "doas" | "su"`
   option?

3. **Generated Quadlet cleanup.** When Quadlet files are removed and
   `daemon-reload` runs, systemd removes the generated services. Are there edge
   cases (e.g., `RemainAfterExit` units) where a manual `systemctl reset-failed`
   is needed?

4. **User-mode systemd activation.** Rootless Quadlet relies on a running user
   systemd instance. Should the extension call `loginctl enable-linger <user>`
   automatically when `userMode: user` is used?

5. **Integration with `@swamp/ssh` fleets.** Should the model accept a
   `hostRef` argument that points to a `@swamp/ssh` host resource so users do
   not duplicate connection data? This can be implemented later via CEL-driven
   fields without a hard dependency.

6. **Helper service cleanup.** Should the readiness helper `.service` file be
   removed after a successful readiness check to avoid leaving one-shot units
   on the host?
