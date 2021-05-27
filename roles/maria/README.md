# maria

Provision a maria database inside a docker container.

Note: All variables are named with maria instead of mariadb despite the official
documentation uses mariadb. The database container is also exposed as maria
instead of mariadb.

## Synopsis

Create a maria server in a docker container. If the server is created first time,
create the specified maria user and maria database in variables.

The server will not publish any ports (or bind port to host). To connect to the server,
attach container to `{{maria_network}}` (default to `{{service_network}}`) for
connecting.

This also create a backup sidecar container for doing backup periodically.

## Requirements

- Ansible >= 2.10 (Tested on 2.10)

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `maria_database`

- Type: `string`
- Required: Yes
- Default: `{{ maria_user }}`

The name of the database. Default to the maria user name.

### `maria_user`

- Type: `string`
- Required: Yes
- Default: `maria`

Name of the user. Note that this is different form root/superuser of maria.
Service depending on maria should use this user for connection instead of root.

### `maria_password`

- Type: `string`
- Required: Yes

Password for the database. Running this role without setting this variable
will cause this role to fail.

## Dependencies

- bootstrap role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "maria"
      vars:
        maria_password: "hunter2"
        maria_user: "some_service_name"
```

## License

MIT
