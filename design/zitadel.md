# Design: Zitadel authentication foundation

**Status:** Implemented baseline

Zitadel is the homelab identity provider and the replacement boundary for the
previous Authentik design. The service is managed as two rootful Podman
Quadlets: the Zitadel API and the separate Zitadel Login V2 UI. Caddy remains
the only public edge and routes the UI and API paths on `auth.holi0317.net`.

## Runtime topology

```text
Internet
  -> Caddy on ingress.network
  -> /ui/v2/login* -> zitadel-login:3000
  -> all other paths -> zitadel-api:8080 over h2c
  -> zitadel-api on postgres.network
  -> PostgreSQL database `zitadel`, owned by role `zitadel`
```

Zitadel state is database-backed in the shared PostgreSQL 16 service. The
protected `/srv/persistent/zitadel/bootstrap` directory stores the generated
login-client PAT used by the Login V2 container. It is owned by root with mode
0700 and mounted read-write only into the API and read-only into Login V2.
The Zitadel master key is not written to disk; it is retained in the `homelab`
1Password-backed Swamp vault and supplied only through the managed container
command.

The API listens only on the container networks. No host port is published;
public access is exclusively through Caddy. Caddy's API upstream uses h2c,
which preserves Zitadel's required HTTP/2 and gRPC path through the reverse
proxy.

## Vault-backed credentials

These keys are required before convergence:

- `postgres.zitadel.password` — dedicated database role password;
- `zitadel.master-key` — exactly 32 characters and immutable after first setup;
- `zitadel.admin-password` — initial `zitadel-admin` organization owner
  password;
- `zitadel.admin-service-key` — machine-user JSON key for the `swamp-iam`
  service account (ORG_OWNER); the credential the OIDC registration model
  authenticates with;
- For confidential clients, OIDC client secrets are minted once by
  `oidc_app_ensure` and auto-stored in the `homelab` vault by swamp.
  Consumers reference the vault key directly:
  `vault.get(homelab, 'thomas-zitadel-<modelId>-oidc_app_ensure-app-credential-<appId>-clientSecret')`.
  The key name is stable across `app_secret_rotate`. Resolving the secret
  through model data does NOT work — the `clientSecret` attribute stores a
  nested `vault.get` CEL string that never re-resolves (probed 2026-09-08).
  Public `clientId` values resolve fine through model data
  (`data.latest("zitadel-iam", "<appId>").attributes.clientId`).
  Grafana's app is a PKCE-only public client (authentication method `none`,
  switched 2026-09-11), so it consumes no client secret; the vault key minted
  for its earlier confidential registration (`…-app-credential-389927371592957967-clientSecret`)
  is inert but retained.

The initial admin password is configured with
`ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD` and is only consumed on first
initialization. Recovery requires the retained master key and the admin account;
subsequent password changes happen in Zitadel's Console. No credential is
committed in model source.

## Application integration boundary

New applications must use Zitadel OIDC and must not recreate an Authentik
proxy or user database. An application owns its Zitadel project/application
registration and callback URLs; the foundation owns the issuer endpoint,
login UI, TLS, persistent state, backup boundary, and bootstrap recovery
material. The issuer is:

```text
https://auth.holi0317.net
```

Relying-party registrations are declarative: the `zitadel-iam` model
(models/apps/zitadel/iam.yaml, type `@thomas/zitadel`) holds the service-account
connection, and the `zitadel-oidc-apps` workflow ensures each application's
project, roles, and OIDC client idempotently — re-running convergence reports
`unchanged`. Per-app client secrets are vault-backed, and user role assignment
stays manual in the Console. The first registered relying party is Grafana;
other applications (Nextcloud, Immich, the git forge) add steps to the same
workflow. No Authentik resources or migration data remain in this repository;
the replacement is a clean Zitadel foundation rather than an Authentik
database migration.

Grafana consumes its registration declaratively: `grafana-config`
(models/apps/grafana/config.yaml, type `@adam/cfgmgmt/file`) renders
`/etc/grafana/grafana.ini` with the `[auth.generic_oauth]` block —
authorize/token/userinfo endpoints under the issuer, `root_url` matching the
Tailscale hostname, JIT user provisioning, PKCE-only client authentication
(the Zitadel app's authentication method is `none` — no client secret; the
PKCE S256 verifier plus the exact redirect URI and project roleCheck gate
code redemption), and `role_attribute_path` mapping
the asserted Zitadel `admin` project role to `GrafanaAdmin` (with
`allow_assign_grafana_admin = true` this grants both the server administrator
role and the org Admin role) with a Viewer fallback. `auto_login = true`
bypasses the Grafana login form for Zitadel; the local recovery form stays at
`/login?disableAutoLogin`. Grafana runs as a single organization (Main Org.,
id 1): every provisioned user auto-joins it, no org mapping is configured,
and no additional orgs are created. The Quadlet mounts the file read-only
into the container, and `machine-ingress-tailnet` applies the file before
starting Grafana so the mount source always exists. Two operational caveats:
SSO settings saved through Grafana's admin UI/API live in the database and
override the ini — keep that store clear or the rendered config never
applies; the Zitadel back-channel logout URI is intentionally left empty
(Grafana does not implement the OIDC Back-Channel Logout spec, so it has no
endpoint to receive logout tokens); and the local vault-backed `admin`
account stays the recovery login (`isExternallySynced` false, unaffected by
Zitadel role changes).

## Managed resources

`models/apps/zitadel/` contains the role, database, protected state directory,
private network, API Quadlet, Login V2 Quadlet, and the `zitadel-iam` OIDC
registration connection. `machine-apps` provisions the database and starts both
containers. The root `machine` workflow converges applications before
`machine-ingress-public`, so Caddy only activates the public route after the
upstream services exist. A final `oidc-apps` machine job runs
`zitadel-oidc-apps` after ingress, because the Management API is reachable only
through the Caddy-published `auth.holi0317.net` route.

The Caddy model supports path-specific subroutes and h2c upstreams for this
split API/Login topology while retaining the existing single-upstream site
contract for other applications.

## References

- [Zitadel Docker Compose deployment](https://zitadel.com/docs/self-hosting/deploy/compose)
- [Zitadel custom domain settings](https://zitadel.com/docs/self-hosting/manage/custom-domain)
- [Zitadel source compose stack](https://github.com/zitadel/zitadel/tree/main/deploy/compose)
