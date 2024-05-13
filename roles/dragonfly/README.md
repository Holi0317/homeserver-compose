# dragonfly

Provision a [dragonfly] database inside a docker container.

[dragonfly]: https://www.dragonflydb.io

## Synopsis

Create a dragonfly server in a docker container.

This dragonfly instance should be shared for all services that needs a redis cache.
The server will be available in `dragonfly` docker network with hostname `dragonfly` at
port `6379`. Services should connect to the network and connect to the host.

We got 16 databases configured. Coordinate the applications so each got their own virtual
host.

## Requirements

- Ansible >= 2.16

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes
- Example: `/srv/services`

Prefix for data storage. Defined in inventory.

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "dragonfly"
```

## License

MIT
