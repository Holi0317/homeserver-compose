# Authentik

Setup [authentik] service in docker

[authentik]: https://goauthentik.io/

## Synopsis

- Create postgres database with postgres role
- Create redis cache server with redis role
- Create docker network for authentik service (We need other service to connect to it)
- Create authentik worker and server in docker
- Expose the authentik web GUI with traefik

## Requirements

- Should be distribution agnostic
- Ansible >= 2.10 (Tested on 2.12)
- traefik role should be started somewhere else

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `postgres_password`

- Type: `string`
- Required: Yes

(Inherited from postgres role) Password for the postgres database

### `smtp_host`

- Type: `str`
- Required: Yes

Hostname for SMTP server. This should also exclude the port number.

We assume TLS is enabled for the SMTP server.

### `smtp_port`

- type: `str`
- Required: Yes

Port for SMTP server

### `smtp_user`

- Type: `str`
- Required: Yes

Login user for SMTP server.

### `smtp_password`

- Type: `str`
- Required: Yes

Login password for SMTP server.

### `authentik_domain`

- Type: `string`
- Default: `auth.holi0317.net`

Domain for hosting authentik

### `authentik_secret_key`

- Type: `string`
- Required: Yes

Secret key for sessions.

This should be a secret variable.

## Dependencies

- bootstrap role
- postgres role
- redis role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "authentik"
      vars:
        postgres_password: "hunter2"
        smtp_host: "example.com"
        smtp_port: "25"
        smtp_user: "username"
        smtp_password: "hunter2"
        authentik_secret_key: "hunter2"
```

## License

MIT
