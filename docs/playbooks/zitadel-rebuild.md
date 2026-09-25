# Playbook: Zitadel rebuilt (fresh instance)

What to do after wiping Zitadel persistent state or standing it up somewhere
new. Assumes the server itself is healthy (see new-server.md).

## 1. Seed the swamp admin service user (manual)

Fresh instance → the vault key is dead. Bootstrap once, authenticated by the
login-client PAT that first-init writes to
`/srv/persistent/zitadel/bootstrap/login-client.pat` (container volume, sudo
read on the node):

1. `swamp vault read-secret homelab zitadel.admin-password -y` (seed human:
   username is the *loginName* `hollis.wu`, not the email).
2. With the login-client PAT as bearer, `POST /v2/sessions` with
   `checks.user.loginName=hollis.wu` + `checks.password` → session token.
3. With the session token as bearer via Management API:
   - `POST /management/v1/users/machine` → service user
     (`machine_user_ensure`-equivalent; username `zitadel-admin-service`).
   - `POST /v2/users/<uid>/keys` (KEY_TYPE_JSON) → machine key JSON.
   - `POST /management/v1/orgs/me/members` with the userId, roles
     `ORG_OWNER` (Management API: member path, replace `me` with the org).
4. `swamp vault put homelab zitadel.admin-service-key "$(cat key.json)" -y`

This can be scripted, but not via the `zitadel-iam` model auth (pre-flight
auth needs the very key we're creating), so it stays a playbook task run by
hand.

## 2. Point the org at `auth.holi0317.net`

Fresh instances only register `zitadel.auth.holi0317.net`. Then:

```
POST /management/v1/orgs/me/domains            {"domain": "auth.holi0317.net"}
POST /management/v1/orgs/me/domains/auth.holi0317.net/_set_primary
```

Otherwise the console + OIDC fail with "Organisation doesn't exist".

## 3. Converge downstream apps

`swamp workflow run machine` — `app-zitadel` converges containers; the
`@holi0317/zitadel` overlay additionally writes a stable `app-grafana`
app-credential data artifact on every `oidc_app_ensure`, so grafana's
`client_id` binds by name instead of a hard-coded app id. After convergence
run `swamp workflow run app-grafana`.
