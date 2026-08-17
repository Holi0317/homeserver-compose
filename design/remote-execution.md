# Design: Shared remote execution for custom models

**Status:** Long-lived

This document defines the stable remote transport boundary for custom model
extensions. It is the permanent transport architecture and must not become a
checklist of temporary migration work.

## Architecture

Remote-backed custom models follow this path:

```text
model method
  -> domain model (`systemd/unit`, `systemd/quadlet`, or future model)
  -> `@holi0317/remote-ssh` workspace package
  -> `ctx.runModel()`
  -> `@swamp/ssh` fleet model
  -> remote host
```

`@swamp/ssh` is the single transport owner. It owns host selection,
OpenSSH/Tailscale behavior, authentication, ControlMaster multiplexing,
retries, output capture, and per-host audit resources. The local package is an
adapter around that model-method interface; it is not another SSH client and
not a Swamp model.

## Principles

### One transport owner

Custom model code must not invoke `ssh`, `scp`, `rsync`, or `tailscale` directly.
It must not create a private SSH pool or duplicate authentication and retry
logic. This keeps connection behavior, secrets, and audit records centralized in
`@swamp/ssh`.

### Domain policy stays local

The shared package exposes transport primitives only. Systemd owns systemd
paths, Quadlet source handling, generated-unit mapping, readiness, enablement,
and tracked-file cleanup. PostgreSQL owns SQL, Podman commands, database
lifecycle, and secret rotation.

If a helper mentions `systemctl`, Quadlet, PostgreSQL, Podman, or a
domain-specific path, it belongs in that domain model or its private helper,
not in this package.

### Bind the target once

Remote model schemas should expose one reusable target reference:

```yaml
remote:
  fleet: hetzner       # @swamp/ssh model instance
  host: hetzner        # logical host name in that fleet
  sudo: true           # domain default; individual operations may narrow it
```

`fleet` describes the referenced model. `host` identifies the fleet member.
Transport settings such as identity, port, Tailscale, and retry policy remain in
the fleet definition. Domain settings such as `userMode`, `unitName`, database
name, and container name remain in the owning model.

### Keep the adapter API smaller than Swamp's context

The public package should hide `ctx.runModel()` request construction and
resource parsing behind a client bound to one target:

```ts
export interface RemoteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RemoteClient {
  exec(options: ExecOptions): Promise<RemoteResult>;
  copy(options: CopyOptions): Promise<RemoteResult>;
}

export function createRemoteClient(
  runModel: RunModel | undefined,
  target: RemoteTarget,
): RemoteClient;
```

`ExecOptions` carries the command, optional privilege request, timeout,
environment, output capture, and explicitly allowed exit codes. `CopyOptions`
carries source, destination, direction, recursion, rsync preference, and
timeout. Exact fields must follow the installed `@swamp/ssh` schema and be
validated at this boundary.

The client must reject an unavailable runner, failed model invocation, empty
result, or malformed/ambiguous single-host result with an error naming the
operation and target. It must validate the selected resource's host and result
attributes rather than blindly taking resource zero.

### Expected non-zero exits are explicit

A non-zero exit is a failure unless the caller supplies an explicit
`okExitCodes` policy. Probes such as `systemctl is-active` may treat a state
exit as a valid answer, but that choice belongs to the domain operation. The
adapter must not convert all non-zero exits into success.

### Secrets never become transport metadata

Passwords, private keys, and database credentials enter through vault
expressions and the upstream fleet model's sensitive fields. They must not
appear in `RemoteResult`, command arguments, resource attributes, tags, debug
logs, temporary file names, or constructed errors. Shell and SQL quoting remain
mandatory at their respective domain boundaries.

### Remote work remains auditable and testable

Every remote operation goes through `@swamp/ssh`, so its per-host outcome is
available to workflows and reports. Domain methods compose those operations
into idempotent actions and write their own typed resources.

The package should be testable with a fake `runModel` callback. Domain tests
should assert generated commands and resource transitions without a network.
One real smoke scenario through the declared fleet remains required before
publishing or relying on a new remote model.

## Package boundary

The workspace package should expose only stable generic transport concepts:

```text
packages/remote-ssh/
  mod.ts             public types and RemoteClient factory
  schemas.ts         target and adapter boundary schemas
  run-model.ts       @swamp/ssh request/response normalization
  shell.ts           POSIX word quoting, if still needed by callers
  file-transfer.ts   generic file primitives, if reused
```

The exact file split may change; the boundary may not. The package must not
export `execSystemctl`, Quadlet policy, PostgreSQL helpers, or a helper whose
behavior depends on `userMode`.

Systemd-specific helpers belong under the systemd extension, for example:

```text
extensions/models/systemd/
  unit.ts             @holi0317/systemd/unit
  quadlet.ts          @holi0317/systemd/quadlet
  _lib/
    types.ts          shared model and policy contracts
    schemas.ts        common arguments and result schemas
    methods.ts        shared Swamp method implementations
    systemctl.ts      systemctl command construction
    paths.ts          systemd and Quadlet target directories
    files.ts          tracked upload and cleanup operations
    readiness.ts      raw helper-service readiness gate
```

PostgreSQL SQL and Podman command builders remain private to the PostgreSQL
extension until its separate design is complete.

## Relationship to existing models

`@adam/cfgmgmt` is the starting point for resource and convergence design. Its
namespaced model types and `check` / `apply` / state-resource pattern are useful
precedent.

It is not a transport library for this repository. Its cloned `_lib/ssh.ts`
uses a separate direct-SSH client. Use `@adam/cfgmgmt` directly when its model
contract fits; custom models use this adapter when they require the repository
fleet, Tailscale behavior, or custom resource ownership.

## Packaging rules

- Keep this package an internal Deno workspace dependency unless a separate
  publication decision is made.
- Use pinned npm specifiers and static imports in extension source.
- Verify that local workspace imports resolve deterministically inside extension
  bundles; do not rely on a root-only imports map at publication time.
- Keep model manifests and package exports explicit.

## Replacement and transport interaction

The transport layer never decides whether a resource must be recreated. That
is domain state logic. A model compares desired and current state, classifies
replacement drift, and applies the permanent rule from
[`model-design-principles.md`](./model-design-principles.md):

- `allowRecreate` defaults to false;
- replacement-required drift fails before destructive work unless explicitly
  allowed;
- the domain model records the replacement and its old/new identity.

The remote adapter only executes the ordered operations requested by the domain
model and propagates failures.
