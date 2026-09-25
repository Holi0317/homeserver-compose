# Playbook: provision a new server (athena-class)

Manual steps to bring up a fresh Hetzner server in a new DC, then converge it
with `swamp workflow run machine`. Host reference here is `sg-athena`; adjust
names as needed.

> [!NOTE]  
> We don't support mutli server setup yet

## 1. Create the machine

1. Create the server + attach volume (this is Terraform, outside this repo).
2. Note the volume's device path (`/dev/disk/by-uuid/<uuid>`)
3. Update DNS if the machine's public IPv4/IPv6 change:
   `auth.holi0317.net` A/AAAA in Cloudflare must point **only** at the new
   machine. Stale old-DC records cause intermittent timeouts everywhere.

## 2. Bootstrap the node by hand

```
ssh root@<public-ip>
```

- Create the model user and passwordless sudo (swamp connects as `hollis.wu`
  and needs sudo; Tailscale SSH policy also only permits this user):
  ```sh
  useradd -m -G sudo hollis.wu
  echo '%sudo  ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/50-noasswd-sudo
  # copy an authorized key, then disable root password login
  ```
- Install Tailscale and connect (auth is interactive; accept in the admin
  tailnet when prompted):
  ```sh
  curl -fsSL https://tailscale.com/install.sh | sh
  tailscale up --ssh --advertise-exit-node --accept-routes
  ```
  Then confirm from the admin machine: `ssh hollis.wu@sg-athena echo ok`.
  Update `models/node/athena.yaml` only if the MagicDNS name or SSH user
  changed.
- Configure Tailscale:
  - Add tags to the machine
  - Disable key expiry
  - Enable exit node

## 3. Point the mount model at the volume

- Format the volume (only if you want new data): `mkfs.ext4 /dev/sda`.
- `blkid /dev/sda` → note the new filesystem UUID.
- Update `models/node/persistent-mount.yaml`'s `What=` UUID to match.

## 4. Converge with swamp

```
swamp workflow run machine
```

Idempotent: bootstrap installs base packages via apt, the mount unit writes
itself, then podman/caddy/postgres/valkey/metrics/logs/zitadel/grafana come
up. Rerun until `Gate: all passed`.

## 5. Fresh-Zitadel notes (only after wiping Zitadel state)

- Primary org domain: the fresh instance registers `zitadel.auth.holi0317.net`
  as the only org domain; `auth.holi0317.net` needs to be added and set
  primary via the Management API, else the console and OIDC logins fail with
  "Organisation doesn't exist".
- Swamp's IAM model authenticates with the machine key in
  `vault homelab zitadel.admin-service-key` — that key belongs to the old
  instance. See the playbook section below for re-seeding it.

## 6. Zitadel-driven apps (grafana etc.)

- If only grafana changed, `swamp workflow run app-grafana`.
- If a *Zitadel instance* was rebuilt, re-bind stale data-artifact references
  (see the notes in `docs/playbooks/zitadel-rebuild.md`).

