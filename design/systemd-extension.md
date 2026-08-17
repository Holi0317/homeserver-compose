# Design: systemd model family

**Status:** The checked-in implementation provides separate
`@holi0317/systemd/unit` and `@holi0317/systemd/quadlet` models. They share
the method and transport mechanics through small internal modules, while each
model owns its schema, naming, target path, enablement, and state policy. The
shared implementation uses an operations interface rather than a public kind
union or a model factory that branches on `unit` versus `quadlet`.

This document describes the current systemd behavior and the domain boundary.
It does not define an SSH client or a second connection schema. Remote
execution is delegated through the internal `@holi0317/remote-ssh` Deno
workspace package to the `@swamp/ssh` fleet model. The shared transport
boundary is maintained in [`remote-execution.md`](./remote-execution.md).
The systemd family uses that shared remote transport for all remote work.

## Goals

Manage one systemd or Quadlet resource on one remote Linux host per model
instance. The current model accepts:

- inline literal unit or Quadlet content; or
- a unit already installed by another mechanism, such as apt, when `content`
  is omitted.

The target split preserves the common lifecycle while making raw-systemd and
Quadlet-specific paths, generated names, enablement, validation, and cleanup
explicit in their respective model contracts. Methods are idempotent and
persist structured resources for later workflow/report inspection.

## Domain boundary

The model owns:

- unit-name validation and raw-systemd versus Quadlet classification;
- systemd and Quadlet target-directory selection;
- `systemctl` lifecycle commands;
- Quadlet enablement, including the generated-unit `.wants/` workaround;
- optional readiness helper services;
- tracked uploaded-file metadata and cleanup.

The shared remote package owns only the adapter to `@swamp/ssh`: command
execution, file copy, result normalization, and generic target binding. It must
not contain `systemctl`, Quadlet, `userMode`, PostgreSQL, or Podman policy.
Custom model code must not invoke `ssh`, `scp`, `rsync`, or `tailscale`
directly.

The upstream `@swamp/ssh` model remains responsible for transport selection,
Tailscale SSH, OpenSSH ControlMaster behavior, authentication, retries,
host-level output, and per-host audit resources.

## Model configuration

The target shape adopted by both remote-backed custom models is:

```yaml
remote:
  fleet: athena        # @swamp/ssh model instance
  host: athena         # logical host name in that fleet
unitName: postgres.container
content: |
  [Container]
  Image=docker.io/library/postgres:16
userMode: system
enabled: true          # optional desired enablement
state: running         # optional desired active state
```

Omit `enabled` or `state` to leave that lifecycle dimension unchanged during
`apply`. `allowRecreate` remains an `apply` method argument because it is
per-invocation consent for destructive replacement. Operation timeouts remain
model-level arguments because a readiness gate and a lifecycle command do not
necessarily share a useful budget.

The committed unit and Quadlet definitions follow the permanent model and
remote-transport principles; future changes should update those documents.

## Target directories

The target directory is derived from the unit extension and `userMode`:

| Unit kind | `userMode` | Target directory |
| --- | --- | --- |
| Quadlet source (`.container`, `.volume`, `.network`, `.pod`, `.image`, `.build`) | `system` | `/etc/containers/systemd/` |
| Quadlet source | `user` | `~/.config/containers/systemd/` |
| Raw systemd unit | `system` | `/etc/systemd/system/` |
| Raw systemd unit | `user` | `~/.config/systemd/user/` |

For user mode, the extension discovers the remote home directory through the
shared adapter before constructing the path. System-mode files may be staged
under `/tmp/swamp-systemd-<uuid>/`, moved into the target directory with the
requested privilege, assigned mode `0644`, and cleaned up. Cleanup is best
effort but must run on both success and failure.

## Methods

### `deploy`

1. If `content` is present, validate the unit extension, choose the target
   directory, ensure it exists, upload the file, and run `daemon-reload`.
2. If `enable` is true, enable the unit. Quadlet-generated units are enabled
   by creating the appropriate `.wants/` symlinks because this host's systemd
   refuses to enable generated units directly.
3. If `start` is true, start the generated or raw systemd unit.
4. If `readiness` is supplied and the unit was started, deploy and poll a raw
   oneshot helper service until it is active or reaches a failure state.
5. Write the `unit` and `runResult` resources.

### `start`, `stop`, and `restart`

Run the corresponding `systemctl` operation against the raw or generated unit
name. `start` may run the optional readiness gate. Each method writes a
`runResult` resource and fails when the remote operation fails.

### `status`

Run `systemctl show` for `ActiveState`, `SubState`, `UnitFileState`, and
`LoadState`, then write the command result. Status is an observation; it must
not be reported as a resource mutation merely because the command succeeded.

### `destroy`

1. Read the stored `unit` resource when available.
2. Stop and disable the unit.
3. Remove only files previously tracked as uploaded by this model instance
   when `removeFiles` is true.
4. Run `daemon-reload` after file removal.
5. Delete the stored `unit` resource and write the `runResult` resource.

Destroying a unit installed by apt or another mechanism must not remove an
untracked file.

## Readiness gate

A readiness argument contains:

```ts
const ReadinessSchema = z.object({
  helperServiceName: z.string(),
  helperServiceContent: z.string(),
  timeoutSeconds: z.number().int().positive().default(60),
  pollIntervalSeconds: z.number().int().positive().default(2),
});
```

The helper is always a raw `.service` file, even when the managed unit is a
Quadlet source. It should be a blocking `Type=oneshot` service with
`RemainAfterExit=yes`. The extension reloads systemd, starts the helper, polls
`is-active`, and includes helper status output when readiness fails.

## Resources

The model writes two resource types:

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
  unitName: z.string(),
  files: z.array(FileRecordSchema),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  deployedAt: z.iso.datetime(),
});
```

`unit` is the desired/managed state needed by `destroy`; `runResult` captures
method, host, unit, success, stdout, stderr, exit code, and timestamp. Remote
per-host outcomes are already auditable through the `@swamp/ssh` fleet model.
Resource names and workflow dependencies should remain stable across the
transport refactor.

## Example

```yaml
# models/apps/postgres/container.yaml
type: "@holi0317/systemd/quadlet"
name: apps-postgres-container
globalArguments:
  remote:
    fleet: athena
    host: athena
  unitName: postgres.container
  content: |
    [Unit]
    Description=PostgreSQL container

    [Container]
    Image=docker.io/library/postgres:16
    ContainerName=postgres
    Network=postgres.network
    Volume=/srv/persistent/postgres/16:/var/lib/postgresql/data

    [Service]
    Restart=always
methods: {}
```

The workflow, not the model, orders this unit after storage and its network:
`workflows/workflow-machine-storage.yaml` remains the orchestration boundary.

## Open domain decisions

1. Run `systemd-analyze verify` locally before uploading inline unit content,
   or rely on the remote daemon reload as the syntax check.
2. Decide whether support for `doas` or `su` belongs in the upstream fleet
   contract before adding another privilege mode.
3. Decide whether user-mode deployment should manage
   `loginctl enable-linger` or require that host prerequisite explicitly.
4. Decide when a successful readiness helper should be removed and how that
   interacts with later `destroy` cleanup.
5. Add contract tests for Quadlet unit-name mapping, target paths, generated
   `.wants/` links, readiness failure states, and tracked-file deletion.

## Publication

The checked-in `extensions/models/systemd/manifest.yaml` is authoritative.
Use the extension guide's manifest formatting, quality, bundle, and smoke-test
checks before publishing. The local `packages/remote-ssh` package must resolve
inside the extension bundle; it must not become an undocumented runtime
installation requirement.
