# redict

Provision a [redict] database (redis fork) inside a docker container.

[redict]: https://redict.io/

## Synopsis

Create a redict server in a docker container.

This redict instance should be shared for all services that needs a redis cache.
The server will be available in `redict` docker network with hostname `redict` at
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
    - role: "redict"
```

## License

MIT
