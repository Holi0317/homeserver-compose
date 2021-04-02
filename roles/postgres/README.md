# Postgres

Provision a postgres database inside a docker container.

## Synopsis

Create a postgres server in a docker container. If the server is created first time, create
the specified postgres user and postgres database in variables.

This role only completes when the postgres server is ready for accepting external connection.

The server will not publish any ports (or bind port to host). To connect to the server,
attach container to `{{postgres_network}}` (default to `{{service_network}}`) for
connecting.

This also create a backup sidecar container for doing backup periodically.

## Requirements

- Ansible >= 2.10 (Tested on 2.10)

## Role Variables

### Required variables

Inherit all required variables from [bootstrap] role. Consult their documentation
for the list of required variables.

[bootstrap]: ../bootstrap/README.md

| Name                | Type | Description               |
| ------------------- | ---- | ------------------------- |
| `postgres_password` | str  | Password for the database |

### Optional variables

Here only list some variables that might be override. For complete list of variables
available, read the `defaults/main.yml` file directly.

| Name                | Type | Default               | Description                                                                                      |
| ------------------- | ---- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `postgres_version`  | str  | "13"                  | Postgres version to be used. Including non-breaking minor versions is supported but discouraged. |
| `postgres_user`     | str  | "postgres"            | Postgres user to be created on first run                                                         |
| `postgres_database` | str  | "{{ postgres_user }}" | Postgres database to be created on first run                                                     |

## Dependencies

- [bootstrap] role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "postgres"
      postgres_password: "hunter2"
      postgres_user: "some_service_name"
```

## License

MIT
