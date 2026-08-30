# OpenCloud vs Nextcloud — spike decision (lab-6td.6)

Evaluated 2026-08-26, revised 2026-08-27 after the deployment context changed
(see Revision 2). No deployment or migration performed in this spike.

**Decision: stay on Nextcloud. Storage Box as primary file store via
SMB/CIFS mount (test-first), per Revision 2.**

## Revision 1 (2026-08-26) — OpenCloud selected

The original evaluation assumed no Nextcloud existed in the environment and
recommended deploying OpenCloud. That premise was wrong; see Revision 2.

Key facts from Revision 1 remain valid for context:

| Dimension | Nextcloud | OpenCloud |
| --- | --- | --- |
| Architecture | PHP app + PostgreSQL + cache + cron/web/fpm containers | Go single binary; **no database**; files + metadata in POSIX filesystem |
| Desktop/mobile clients | First-party, mature | First-party Windows/macOS/Linux/iOS/Android; Files On-Demand (Windows + mobile) |
| Sharing | Internal shares, public links (password/expiry), Teams | Shares with roles, Spaces with quotas, public links, federation |
| Versions / trash / search | Configurable retention; optional full-text engines | Present; retention config poorly documented; built-in content search |
| Office | Collabora or OnlyOffice | Collabora only |
| Calendar/Contacts/Talk/News apps | Rich ecosystem | None (CalDAV/CardDAV claim premium-gated) |
| OIDC | Well-trodden external IdP support | Embedded IdP is LibreGraph Connect (Zitadel-derived); external IdP provider-independent config; Zitadel not officially documented |

Primary sources: [features](https://docs.opencloud.eu/docs/admin/features),
[requirements](https://docs.opencloud.eu/docs/admin/getting-started/requirements),
[external IdP](https://docs.opencloud.eu/docs/admin/configuration/authentication-and-user-management/external-idp),
[server README](https://github.com/opencloud-eu/opencloud),
[migration limits](https://docs.opencloud.eu/docs/admin/maintenance/migrate).

## Revision 2 (2026-08-27) — Storage Box requirement changes everything

User-reported ground truth: an existing Nextcloud instance already holds ~300 GB
of user data shared with ~5 people; an anime video collection is being split
off to Jellyfin. Cheap bulk storage on a Hetzner Storage Box is a hard
requirement. The platform must therefore be evaluated **with the data directory
on Storage Box storage**, which reverses the choice.

### Why OpenCloud fails on Storage Box — verified at code level

OpenCloud offers exactly three storage drivers (`posix`, `decomposed`,
`decomposeds3`), all decomposedfs variants:

1. Every variant requires local POSIX semantics: atomic rename writes,
   `flock` lockfiles, one symlink per visible node, upload staging dirs.
   Only blob *bytes* can be offloaded to S3 (`decomposeds3`, via minio-go);
   metadata (`messagepack` sidecars), locks, symlink tree, and staging must
   sit on local disk. Maintainer confirmation: opencloud-eu/opencloud#1455.
2. CIFS/SMB is broken by design: SMB attribute names cannot contain `:` while
   decomposedfs keys xattr grants as `user.oc.grant.u:<uuid>` (issue #2173);
   CIFS-mounted data dirs fail immediately with `user.oc.name: no data
   available` (#3190); Storage Boxes do not support symlinks at all (#1455).
3. There is no WebDAV/SFTP/SMB *client* driver anywhere in reva/OpenCloud
   (verified: `services/storage-users/pkg/revaconfig/user.go` registers only
   the three drivers; cs3org/reva's 15 fs packages have none either). External
   storage FRs #894/#2073 were explicitly deprioritized by core devs.
4. Even documented network FS support (NFS ≥ 4.2 + `noac`) degrades badly in
   practice (#1596: "basically unusable... stuttering uploads"); maintainers
   name only CephFS/GPFS/SaunaFS as large-scale-viable.

Not "untested" — impossible without a fork. A Storage Box can only ever serve
as OpenCloud's *backup* target (rclone/restic), never its runtime store.

Hetzner Object Storage (€6.49 base incl. 1 TB, €6.26/TB-month after) would be
the supported bulk backend for OpenCloud blobs, but blobs-only still forces a
local metadata SSD, and at ~300 GB its effective cost (~€8–9/mo) exceeds the
Storage Box option below with less operational upside.

### Nextcloud on Storage Box over CIFS/SMB — conditionally viable

Nextcloud's datadirectory on a CIFS mount is neither documented-recommended nor
prohibited; it is a community-common pattern with known edges:

- Endorsed by the flagship official deployment product: Nextcloud All-in-One
  FAQ answers "Can I use a CIFS/SMB share as Nextcloud's datadir?" with
  "Sure." and ships a full recipe including an `/mnt/storagebox` example
  (`rw,mfsymlinks,seal,uid=33,...`)
  ([AIO README](https://github.com/nextcloud/all-in-one#can-i-use-a-cifssmb-share-as-nextclouds-datadir)).
- Same README instructs moving appdata/previews to an SSD when the datadir is
  on a network FS — adopted here as a design rule.
- File locking is engineered above the FS layer (Redis/Valkey memcache.locking;
  the DB default merely loads the database), so correctness on CIFS does not
  depend on mount locking
  ([transactional locking docs](https://docs.nextcloud.com/server/latest/admin_manual/configuration_files/files_locking_transactional.html)).
- Known live issues as of Aug 2026: mtime loss on SMB uploads (server#48885),
  preview generation failing for external-mount files (server#60846), dotfile
  overwrite returning HTTP 500 with CIFS+SSE (server#63017), `.part` staging
  skipped on WebDAV overwrite via #62853 mechanism, and desktop-client
  change-detection relying on periodic scans rather than notify (inotify cannot
  fire through CIFS; `files_external:notify` is broken since NC33 and never
  worked reliably outside Windows servers anyway).
- Small-scale users run datadirs on CIFS successfully today (personal servers,
  same-datacenter Hetzner VPS↔Box pairs); genuinely bad reports cluster around
  WebDAV-as-datadir or cross-WAN mounts. Failure mode on Storage Box SMB is
  timeout-shaped under parallel load, mitigated but not eliminated by mount
  options (`cache=loose`, `actimeo=30`) and keeping tempdir/appdata local.

Verdict: viable at this scale (one main user + ~5 sharees) **only behind a
deliberate test gate**, because anime-size video writes through WAN-latency
SMB are the sharpest corruption edge.

## Revised decision and design

1. Platform: **keep Nextcloud**, version-34-ish current stable, existing
   instance migrated onto athena rather than replaced by OpenCloud.
2. Storage layout:
   - CIFS mount of the Storage Box at e.g. `/srv/media/nextcloud-data`
     (SMB3 multichannel where possible; options `rw,mfsymlinks,seal,actimeo=30,
     noserverino,cache=loose,credentials=/etc/...,file_mode=0770,dir_mode=0770`),
     uid/gid matching the container runtime user since chown is impossible
     on CIFS.
   - Datadirectory (the share's file payload): on the CIFS mount.
   - Appdata (`appdata_xxx` incl. preview cache) and tempdirectory: forced
     local NVMe via `occ config:system:set appdata|tempdirectory` plus bind
     mounts, mirroring AIO's move-appdata-off-network-FS recipe.
   - PostgreSQL: stays on `/srv/persistent` NVMe (databases never go on
     network shares; NixOS SSHFS precedent and ownCloud forum NFS story agree).
   - Valkey required (not optional): transactional file locking offload +
     shares session store.
3. Test gate before cutover (fail any → revise):
   - Write a 10 GB file by WebDAV/desktop client; verify checksum + mtime
     survive.
   - Parallel-upload burst test (10 concurrent clients).
   - Preview generation works for files living on the mount.
   - Dotfile overwrite (CIFS+SSE combination) returns non-500.
4. Backup: keep DB dumps on NVMe → restic to a *second* Storage Box sub-account
   or Object Storage bucket; CIFS datadir additionally covered by Hetzner
   Box-level snapshots (10 included on BX11, more on larger tiers).
5. Migration of ~300 GB: rsync the data dir (server-side or mounted), then
   point datadirectory at the mount; preserves mtimes (rsync-style transfers
   are reported to preserve them where SMB uploads lose them) and avoids the
   AIO "sure"-path re-provisioning churn.
6. Sharing for ~5 friends is unchanged — this is exactly what the existing
   instance already does.

OpenCloud remains worth revisiting only if the Storage Box constraint is ever
dropped in favor of (a) plain local NVMe growth, or (b) S3-class object
storage for everything including metadata — it has no such roadmap today.

## Naming and ingress

Unchanged from before, now pointing at the real service instead of a future
deployment: public host `nextcloud.holi0317.net`, tailnet `svc:nextcloud`,
containers `nextcloud-web`, `nextcloud-fpm`, `nextcloud-cron`; network
`nextcloud.network` joined to `ingress.network` per `design/ingress.md`.

## Follow-up

Execute lab-6td.1: stand up the Nextcloud stack (web/fpm/cron + Valkey,
existing Postgres role/db models) with the CIFS datadir per this design,
run the four-item test gate, then migrate the production instance and ~300 GB
dataset onto it.

## Revision 3 (2026-08-27) — alternatives survey ("horrible to maintain")

Surveyed against the hard constraints (Storage Box bulk storage, ~6 sync
users, Zitadel OIDC, existing PostgreSQL 16, Podman/Caddy ingress).

### Fails outright

- **Seafile CE** — best turnkey replacement on paper (first-party clients
  incl. virtual drive, library shares, public links, versions, trash), but:
  chunked block-store payload is opaque to Jellyfin; CIFS datadir reports are
  poor (symlink/hardlink trouble on mounts — Seafile forum #7224); MariaDB
  only, no PostgreSQL; search/office/rw-WebDAV are Pro-gated. Its only sane
  shape here is seafile-data on NVMe + Borg to the Box, inverting the
  storage goal.
- **Pydio Cells** — real sync clients, but external OIDC is Enterprise-only
  (~€3,280/yr) and MariaDB is mandatory. Dead on arrival for Zitadel.
- **ownCloud Classic** — maintenance-mode twin of Nextcloud's PHP stack,
  slower cadence (10.15→10.16 took ~18 months), vendor steering to oCIS.
- **Filestash** — OSS build lacks share links/versioning/OIDC (paid catalog);
  no sync clients. A web window, not a platform.
- **Dufs / MinIO-frontends / Sandstorm / FileRun** — no sync clients, no
  share lifecycle, or wrong storage shape / dead licenses.

### Conditional compositions

- **Syncthing + copyparty** — the only design that reaches the Storage Box
  via its *native* rsync/Borg protocols, no CIFS mount at all; payload stays
  plain files (Jellyfin-readable). copyparty adds password/expiry share
  links, upload inboxes, thumbnails; explicitly documents keeping its SQLite
  index/thumbnails off network mounts (`--hist`/`--dbpath`). Weaknesses: no
  native OIDC (header-IdP middleware), bus factor ~1, no trash/versioning on
  CIFS volumes, and Syncthing on Android survives only via the maintained
  fork (official app discontinued Dec 2024).
- **Syncthing + FileBrowser Quantum** — native OIDC + expiring per-share
  links in a single Go binary; but v2 is beta, trash/quotas "under
  construction", smaller community.
- **Nextcloud AIO** — if staying: most of the maintenance pain is
  self-inflicted by manual docker-compose. AIO ships web-UI updates, built-in
  BorgBackup with UI create/restore/integrity-repair, auto-wired
  PostgreSQL+Redis. Fixes ops pain, NOT the CIFS datadir fragility (AIO
  blesses the Box recipe but upstream issues stay open).
- **Hetzner Storage Share** (managed Nextcloud) — zero sysadmin work,
  several automatic backups daily, official clients. Live prices (2026-08):
  NX11 1 TB €4.29, NX21 5 TB €14.19, NX31 10 TB €27.39 net/month. At 5 TB it
  is cheaper than BX31 (€20.80) — the managed product undercuts the DIY Box
  at that tier. Caps: 7 users on NX21 (fits); no external IdP (built-in auth
  only); WebDAV-only, so it cannot serve the local Jellyfin library from the
  same storage.

### Net assessment

No single product beats Nextcloud for this user's combined requirements
*and* the Storage Box constraint. The real decision is between:
1. **Stay, de-pain:** Nextcloud AIO + CIFS datadir test gate (current plan).
2. **Syncthing + copyparty/FBQ:** lowest maintenance + Box-native storage,
   at the cost of no unified sharing/OIDC story and manual link juggling.
3. **Storage Share:** eliminate maintenance entirely for ~€14/mo, at the
   cost of Zitadel federation and Jellyfin library access.

Decision unchanged pending user input: option 1 is the recorded plan; the
alternatives are documented for reconsideration at lab-6td.1 execution time.
