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
  password.

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

The first operational relying-party check is the Zitadel Console login at
`/ui/console`, which exercises the public Login V2 and API routing. Application
workloads should add their OIDC client registration and vault-backed client
credentials as part of their own deployment issue. No Authentik resources or
migration data remain in this repository; the replacement is a clean Zitadel
foundation rather than an Authentik database migration.

## Managed resources

`models/apps/zitadel/` contains the role, database, protected state directory,
private network, API Quadlet, and Login V2 Quadlet. `machine-apps` provisions
the database and starts both containers. The root `machine` workflow converges
applications before `machine-ingress-public`, so Caddy only activates the
public route after the upstream services exist.

The Caddy model supports path-specific subroutes and h2c upstreams for this
split API/Login topology while retaining the existing single-upstream site
contract for other applications.

## References

- [Zitadel Docker Compose deployment](https://zitadel.com/docs/self-hosting/deploy/compose)
- [Zitadel custom domain settings](https://zitadel.com/docs/self-hosting/manage/custom-domain)
- [Zitadel source compose stack](https://github.com/zitadel/zitadel/tree/main/deploy/compose)
