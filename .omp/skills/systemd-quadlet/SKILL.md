---
name: systemd-quadlet
description: >
  Authoring and deploying Swamp-managed systemd Quadlet services on remote
  hosts. Use for Podman containers, networks, protected state directories,
  service dependencies, readiness, health checks, secret wiring, and
  convergence workflows.
---

# Systemd Quadlet authoring

Use this skill when creating or changing a Swamp model whose rendered resource
is a systemd unit or Podman Quadlet.

## Before editing

1. Inspect an adjacent working model of the same kind. Reuse its global
   arguments, remote execution boundary, unit naming, and method arguments.
2. Inspect the type contract:

   ```bash
   swamp model type describe @holi0317/systemd/quadlet --json
   swamp model type describe @holi0317/systemd/unit --json
   ```

3. Create new models through Swamp first, then edit the generated scaffold:

   ```bash
   swamp model create @holi0317/systemd/quadlet <name> --json
   ```

   Never invent model IDs or hand-copy a generated resource ID.
4. Keep secrets in vault expressions. Do not put secret values in model files,
   command arguments, workflow inputs, logs, or test output.

## Quadlet dependency rules

- A Podman network is referenced in a container with `Network=foo.network`.
  The systemd dependency is normally `foo.network`, not
  `foo.network.service`.
- Use both ordering and lifecycle dependencies when a service cannot function
  without another resource:

  ```ini
  Wants=app.network postgres.service app-data-dir.service
  After=app.network postgres.service app-data-dir.service
  Requires=app.network postgres.service app-data-dir.service
  ```

- Add `RequiresMountsFor=` for persistent host paths.
- Keep dependency direction acyclic. A login/UI container may require an API;
  the API must not require the login/UI container.
- If a service joins a shared ingress network, model that network explicitly in
  the workflow or make the workflow depend on the workflow that creates it.
- Put public ingress after application startup when the ingress configuration
  requires live upstreams. Caddy can sometimes start before DNS names exist,
  but that is not a useful readiness guarantee.

## Container definition checklist

For each container, explicitly decide:

- image and immutable version tag;
- `ContainerName` and network memberships;
- user/root requirement;
- persistent volumes and their ownership/mode;
- published ports (prefer no host publication when Caddy can reach the private
  network directly);
- vault-backed environment values;
- resource limits and restart policy;
- initialization command versus steady-state command;
- readiness and failure behavior;
- whether a dependent container must be restarted after this one.

Use a dedicated private network for services that need private east-west
traffic. Use a shared ingress network only for traffic that must reach Caddy.

## Health checks: the shell trap

Quadlet `HealthCmd=` is commonly rendered to Podman as a shell-form health
command. Do not assume it executes an argv array. In particular:

- `HealthCmd=/app/service ready` usually becomes `/bin/sh -c '/app/service ready'`;
- distroless images may not contain `/bin/sh`, making an apparently correct
  health check permanently unhealthy;
- JSON-looking values and `PodmanArgs` quoting must be verified against the
  actual generated container, not trusted from the source file.

After applying a health change, inspect the real result:

```bash
podman inspect --format '{{json .Config.Healthcheck}}' <container>
podman inspect --format '{{.State.Health.Status}}' <container>
```

Prefer, in order:

1. an image-supported shell-form check;
2. an image-supported direct executable check, if the Quadlet/Podman version
   preserves argv form and inspection proves it;
3. a host-side systemd readiness gate that invokes a direct binary and waits for
   the generated state; or
4. no container health check, with an explicit direct readiness smoke test.

Never paper over a false unhealthy state with `true`. If the image is
shell-less and the local Quadlet version cannot preserve exec-form health
commands, document why `HealthCmd=none` is used and verify readiness through
the real API/UI path.

## Initialization and generated state

Initialization often creates files asynchronously after the container unit is
started. For generated credentials or bootstrap files:

- create the parent directory declaratively with restrictive ownership and
  mode;
- wait for the generated file before applying permissions;
- make permission hooks bounded and idempotent;
- do not assume `ExecStartPost` runs after application-level initialization;
  use a bounded loop when the file is created by the service;
- verify the resulting file mode on the remote host.

A typical host-side permission hook is safer than exposing the secret through a
command argument:

```ini
ExecStartPost=/bin/sh -c 'i=0; while [ "$i" -lt 60 ]; do if [ -f /srv/persistent/app/bootstrap/token ]; then chmod 0600 /srv/persistent/app/bootstrap/token; exit 0; fi; i=$((i + 1)); sleep 1; done; exit 1'
```

## Apply versus restart

`apply` can update the generated unit and daemon-reload without restarting an
already-running service. After changing container content, health policy,
volumes, or dependencies:

1. run `apply`;
2. inspect the model result and unit status;
3. explicitly restart/start when the runtime must consume the change;
4. re-start dependents that were stopped by `Requires=` during the restart;
5. perform the actual readiness smoke test.

Do not declare success from `apply` alone.

## Workflow contract

Each service workflow step should have a single purpose and explicit
`dependsOn` entries. Separate database role, database, persistent directory,
network, API, and UI steps when they have independent ordering. Validate before
running:

```bash
swamp workflow validate <workflow> --json
swamp workflow run <workflow>
```

On a failed model method, inspect its report before changing the definition or
retrying:

```bash
swamp report get @swamp/method-summary --model <model> --json
```

## Verification

Verify the running surface, not only the source:

- inspect systemd/model status;
- inspect Podman state and health configuration;
- check persistent path ownership and modes;
- query the real endpoint from the intended network boundary;
- for web services, drive the real browser surface and complete a login or
  application flow;
- run the changed-contract tests and formatter once at the end.
