# Postgres

Provision a redis database inside a docker container.

## Synopsis

- Create redis server with AOF persistent enabled
- Wait for the redis server to be ready

The server will not publish any ports (or bind port to host). To connect to the server,
attach container to `{{ redis_network }}` (default to `{{ service_network }}`) for
connecting.

For authentication, we do not setup any password. So users of redis can just
connect to `redis:6379`.

## Requirements

- Ansible >= 2.10 (Tested on 2.10)

## Role Variables

We are not listing all variables here but only the ones user may want to customize.
See `defaults/main.yml` for detailed list of variables.

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap) Path prefix for all persistent data

### `service_name`

- Type: `string`
- Required: Yes

(Inherited from bootstrap) Name of the service to be setup

### `redis_version`

- Type: `string`
- Default: `6`

Redis version to be used

## Dependencies

- [bootstrap] role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "redis"
```

## License

MIT
