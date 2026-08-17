# Master Plan: Hetzner Homelab via Swamp

> Living document for the migration of the homeserver-compose homelab to a
> Hetzner Cloud VM managed declaratively through
> [swamp](https://github.com/swamp-club/swamp).
>
> Agents should read this file before making changes. Update statuses and add
> notes as work progresses.

## 1. Objective

Move the existing Ansible-managed homelab onto a single Hetzner Cloud VM and
manage it through this repository using swamp models and workflows.

## 2. Target machine

- **Host:** Hetzner Cloud VM
- **Access:** Tailscale SSH (`sg-athena.tail351aa.ts.net`)
- **User:** `hollis.wu` with passwordless sudo
- **OS:** Debian

## 3. Storage layout

| Tier | Medium | Mount / path | Use for |
|------|--------|--------------|---------|
| **NVMe** | Local VM disk (fast, "ephemeral") | Root filesystem, `/var/lib/containers` | OS, Podman graph/storage, build/package caches, **VictoriaMetrics data**, **VictoriaLogs data** |
| **Block storage** | Hetzner Cloud Volume (persistent SSD) | `/srv/persistent` | PostgreSQL data, application config/state DBs, small important persistent data |
| **Storage Box** | Hetzner Storage Box via **NFSv4.1** | `/srv/media` (planned) | Jellyfin, Immich, Nextcloud media and large files |

**Guiding principle:** observability stores (metrics/logs) are heavy-write and
latency-sensitive; they belong on NVMe. They are also acceptable to lose on a
rebuild. Snapshot or back them up to block storage / S3 only when long-term
retention is required.

## 4. Architectural principles

- **Single box, single Postgres.** All services share one PostgreSQL server and
  use separate logical databases.
- **Podman + Quadlet.** Applications run as rootless or system containers
  defined by Quadlet files (`.container`, `.network`, `.volume`, `.pod`) and
  managed by the custom `@holi0317/systemd/quadlet` model. Custom raw systemd
  resources use `@holi0317/systemd/unit`; `@adam/cfgmgmt/systemd` remains the
  behavioral starting point and is used where its contract fits.
- **Shared Valkey.** One Redis-compatible Valkey instance with virtual-host
  separation (separate logical databases or ACL users) for caching/session
  needs.
- **Monitoring from day one.** Node-level and service-level metrics/logs flow
  into VictoriaMetrics / VictoriaLogs and are visualized in Grafana, with
  alerting.
- **Prefer existing models.** Use `@adam/cfgmgmt` and official `@swamp/*`
  models when they cover the domain. Write custom extensions in
  `extensions/models/` only as a last resort, and model them after
  Ansible/Terraform idioms (idempotent `apply`, explicit `ensure`, state
  resources).
- **Shared remote boundary.** Remote-backed custom models use the internal
  `@holi0317/remote-ssh` Deno workspace package, which delegates to the single
  `@swamp/ssh` fleet model. It owns no domain policy and does not shell out to
  SSH directly. See [`remote-execution.md`](./remote-execution.md).
- **Model boundaries.** Use namespaced types for distinct resource contracts,
  prefer existing `@adam/cfgmgmt` models, and split model kinds only when
  lifecycle/state semantics differ. See
  [`model-design-principles.md`](./model-design-principles.md).
- **Secrets in vault.** Passwords, API keys, and tokens must live in swamp
  vault, never in plain-text model files.

The permanent remote transport architecture is documented in
[`remote-execution.md`](./remote-execution.md).

## 5. Repository conventions

```text
vaults/
  @swamp/1password/
files/
  terminfo/
    xterm-ghostty       # generated with infocmp -x xterm-ghostty
models/
  node/
    athena.yaml          # @swamp/ssh fleet / host definition
    persistent-mount.yaml # native systemd mount for /srv/persistent
  bootstrap/
    *.yaml                # base OS configuration (journald, apt, registries, etc.)
  apps/
    <app>/
      *.yaml              # all resources owned by the application
      # e.g. container.yaml, network.yaml, database.yaml, role.yaml, secret.yaml
workflows/
  workflow-machine.yaml             # canonical machine convergence root
  workflow-machine-bootstrap.yaml   # base OS + tailscale
  workflow-machine-storage.yaml     # disks + postgres
  workflow-machine-monitoring.yaml  # node_exporter + victoria* + grafana
  workflow-machine-shared.yaml      # valkey and shared services
  workflow-machine-apps.yaml        # shared services + applications

extensions/models/
  systemd/              # systemd model family
    unit.ts              # @holi0317/systemd/unit model
    quadlet.ts           # @holi0317/systemd/quadlet model
  postgres/              # PostgreSQL model family
    _lib.ts              # shared PostgreSQL execution helpers
    database.ts          # @holi0317/postgres/database
    role.ts              # @holi0317/postgres/role
  podman/                # Podman model family
    secret.ts            # @holi0317/podman/secret
packages/
  remote-ssh/            # shared @swamp/ssh adapter workspace package
    mod.ts
    deno.json
```

Application-owned resources belong under `models/apps/<app>/` and use short,
resource-oriented filenames. Node resources belong under `models/node/`;
bootstrap resources remain under `models/bootstrap/`.

### Model definition filenames

`swamp model create` currently scaffolds model definitions with a UUID filename
under the model type directory. Move each definition into its domain directory
and give it a stable, human-readable resource filename. Preserve the
Swamp-assigned `id` and model `name` fields; never generate or replace model
IDs manually. Existing UUID-named definitions should be renamed when migrated,
not duplicated.

## 6. Workflows

| Workflow | File | Status | Notes |
|----------|------|--------|-------|
| Machine convergence root | `workflows/workflow-machine.yaml` | ✅ Done | Canonical root workflow that composes the machine domain workflows |
| Bootstrap machine | `workflows/workflow-machine-bootstrap.yaml` | ✅ Done | Base packages (+ncdu, tailscale), dynamic tailscale repo from `/etc/os-release`, journald 512MB cap, apt autoclean, coredump 1GB cap, mirror.gcr.io for docker.io, weekly podman image prune |
| Storage + Postgres | `workflows/workflow-machine-storage.yaml` | ✅ Done | Native `srv-persistent.mount` unit, Postgres quadlet |
| Monitoring | `workflows/workflow-machine-monitoring.yaml` | ⬜ Not started | VictoriaMetrics, VictoriaLogs, Grafana, node_exporter, alerting |
| Shared services | `workflows/workflow-machine-shared.yaml` | ⬜ Not started | Valkey |
| Applications | `workflows/workflow-machine-apps.yaml` | ⬜ In progress | Nextcloud database resources are present; application containers remain to be migrated |

## 7. Application inventory

Use this list to track per-application work. Mark items `[x]` only when the
service is deployed, reachable, monitored, and backed up (where applicable).

### Core infrastructure

- [x] Tailscale networking
- [x] Base packages (podman, cron, neovim, ncdu, tailscale)
- [x] Persistent block storage mount (`/srv/persistent`)
- [x] Storage blow-up mitigations (journald, apt, coredump, podman prune, docker.io → mirror.gcr.io)
- [x] PostgreSQL 16 on `/srv/persistent/postgres/16`
- [ ] Valkey (shared Redis-compatible cache)
- [ ] Cron script deployment + failure monitoring

### Observability

- [ ] Node exporter
- [ ] VictoriaMetrics
- [ ] VictoriaLogs
- [ ] Grafana
- [ ] Alerting rules + notification channel

### Applications

- [ ] Nextcloud
- [ ] Jellyfin
- [ ] Immich
- [ ] Gitea
- [ ] Authentik
- [ ] DDNS updater
- [ ] CUPS
- [ ] AirSane

## 8. Known issues and decisions

- **Postgres superuser password is in 1Password vault** (`homelab` →
  `postgres.superuser`) but is still the bootstrap value `CHANGEME`. Rotate it
  before any real data is loaded.
- **Quadlet enablement:** the current `@holi0317/systemd` extension enables
  Quadlet units by creating `.wants/` symlinks because `systemctl enable`
  refuses generated units on this Debian/systemd version.
- **Storage Box mount:** not yet implemented. Decide whether to use
  NFSv4.1 (recommended) or CIFS, and whether root-squash requires a dedicated
  media user.
- **Storage management:** journald is capped at 512 MB, apt cache is
  auto-cleaned weekly, systemd-coredump is capped at 1 GB, and dangling
  container images are pruned weekly. Container image pulls for `docker.io`
  are routed through `mirror.gcr.io` via `/etc/containers/registries.conf.d`.
  Application-level log rotation inside containers still needs to be handled
  per app.

## 9. Next recommended steps

1. Rotate the Postgres superuser password (`postgres.superuser`) in 1Password.
2. Authenticate 1Password CLI (`eval $(op signin)`) and store app DB passwords
   (e.g. `postgres.nextcloud.password`), then run `nextcloud-db.provision`.
3. Deploy the monitoring stack on NVMe.
4. Mount the Hetzner Storage Box at `/srv/media`.
5. Deploy Valkey as a shared service.
6. Begin application deployments (Nextcloud / Jellyfin / Immich first).
