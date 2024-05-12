# Postgres

Provision a postgres database inside a docker container.

## Synopsis

Create a postgres server in a docker container. If the server is created first time, create
the specified postgres user and postgres database in variables.

This role only completes when the postgres server is ready for accepting external connection.

The postgres user and database is not supposed to store any application data. Create
separate users and database for each applications.

The server will publish port 5432 on the host, but that's just for ansible to create
database and users for applications. Containerized apps should attach their container to
`postgres` network and connect to the database with hostname `postgres`.

~~This also create a backup sidecar container for doing backup periodically.~~ TODO. Was
there before the cluster consolidation.

We also install psycopg2 via dnf so that ansible postgres module will work.

## Requirements

- Ansible >= 2.16

## Role Variables

### Required variables

| Name                | Type | Description               |
| ------------------- | ---- | ------------------------- |
| `postgres_password` | str  | Password for the database |

### Optional variables

Here only list some variables that might be override. For complete list of variables
available, read the `defaults/main.yml` file directly.

| Name               | Type | Default | Description                                                                                      |
| ------------------ | ---- | ------- | ------------------------------------------------------------------------------------------------ |
| `postgres_version` | str  | "16"    | Postgres version to be used. Including non-breaking minor versions is supported but discouraged. |

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "postgres"
      vars:
        postgres_password: "hunter2"
```

## License

MIT
