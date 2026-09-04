---
name: systemd-operations
description: >
  Operating and debugging Swamp-managed systemd and Podman services on remote
  hosts. Use for status, logs, failed starts, Quadlet convergence, dependency
  restarts, readiness checks, generated unit inspection, and safe recovery.
---

# Systemd and Quadlet operations

Use the managed Swamp models and the repository's remote execution model. Do
not bypass the model with ad-hoc SSH, raw cloud APIs, or direct edits to
`.swamp` state.

## First response to a failure

Do not immediately retry or alter the definition. Inspect the generated method
report first:

```bash
swamp report get @swamp/method-summary --model <model> --json
```

Then inspect the service on the remote host through the SSH model. Keep remote
commands small and sequential:

```bash
swamp model method run <service-model> status
swamp model method run athena exec \
  --input hosts=athena \
  --input sudo=true \
  --input command='systemctl status <unit>.service --no-pager'
swamp model method run athena exec \
  --input hosts=athena \
  --input sudo=true \
  --input command='journalctl -u <unit>.service -n 100 --no-pager'
```

For a compound remote command, explicitly wrap it in `sh -c` so the sudo and
remote execution boundary are unambiguous. Avoid relying on implicit shell
parsing for pipes, redirects, loops, or conditionals.

## Inspect the actual generated runtime

The source Quadlet file and the running container are not necessarily the same
thing. Inspect both after a change:

```bash
systemctl show <unit>.service --property=ExecStart --value
podman inspect <container>
podman inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' <container>
```

For health problems, inspect `.Config.Healthcheck` as well as the status. A
shell-form command against a shell-less image is a common false failure.

For generated unit content, inspect the deployed Quadlet source and generated
systemd unit through the remote execution model. Do not infer quoting behavior
from the YAML alone.

## Swamp data output hazards

Remote execution methods may write to a fixed data name such as
`run-exec-athena`. Concurrent calls can overwrite the result you are about to
read. Serialize calls that use the same output name:

```bash
swamp model method run athena exec ...
swamp data get athena run-exec-athena --json
```

Read the data immediately, and avoid launching another remote execution in
parallel until the result is captured. Prefer a model method with a unique
output contract when one exists.

Never use `.swamp` files as an alternate remote state database. Use `swamp
data query`, `swamp data get`, model reports, or a managed SSH method.

## Restart and dependency behavior

A successful restart of a required service can stop dependent units. After
restarting an API or database, check the complete dependency chain rather than
assuming the UI recovered:

```bash
swamp model method run <api-model> restart
swamp model method run <ui-model> start
swamp model method run <api-model> status
swamp model method run <ui-model> status
```

This is especially important when the UI has `Requires=api.service`. The
reverse dependency is not automatic: starting the API does not necessarily
start a UI that was stopped as a consequence of the restart.

Use `start` for a stopped enabled unit, `restart` when the running process must
consume changed content, and `apply` when only model/unit convergence is
needed. Confirm the resulting unit state after every operation.

## Safe recovery sequence

For a failed or stale service:

1. inspect the method report;
2. inspect `systemctl status` and recent journal output;
3. inspect container state, image, mounts, networks, and health definition;
4. identify whether the failure is source drift, a stale running unit, a
   dependency stop, a missing network, a readiness race, or a real application
   error;
5. make the smallest model change that fixes the cause;
6. run `apply`, then explicitly restart/start the affected chain;
7. verify the actual endpoint and persistent state;
8. rerun the model/workflow only after the cause is understood.

Do not use `systemctl reset-failed`, `podman rm -f`, or broad cleanup as the
first fix. Destructive recovery requires a verified target and a clear reason.

## Secrets and persistence

Never print vault values while debugging. Verify only metadata, presence, file
size, ownership, and mode. For bootstrap files:

```bash
stat -c '%A %U:%G %s %n' /srv/persistent/<app>/bootstrap/<file>
```

A restrictive directory does not make a world-readable file safe. Check the
file itself and enforce `0600` or the narrowest required mode after generation.

Prefer vault expressions in Quadlet environment values. Avoid putting secrets
in `ExecStart`, workflow inputs, shell command arguments, reports, or browser
logs.

## Web-service verification

A systemd unit being active is not proof that a web service works. Verify in
this order:

1. container is running;
2. API readiness or Login/UI health endpoint responds;
3. reverse proxy reaches the intended upstream;
4. TLS and host routing select the intended site;
5. browser loads the real UI;
6. complete an authenticated login or OIDC discovery/application flow.

For split services, verify each path independently—for example, the Login UI
path and the API/OIDC discovery path. A successful response from the wrong
upstream is still a routing failure.

## Completion checklist

Before closing a service issue:

- model and workflow validation pass;
- failed method reports were inspected where applicable;
- generated unit and actual container configuration agree;
- all dependencies are running after the final restart;
- persistent files have correct ownership and modes;
- real API/UI smoke test passes;
- changed-contract tests and formatting pass;
- Beads issue status reflects the actual result;
- git status and the final commit are reported if committing was requested.
