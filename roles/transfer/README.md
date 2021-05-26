# Transfer

Setup [transfer.sh] service in docker

[transfer.sh]: https://github.com/dutchcoders/transfer.sh/

## Synopsis

- Create data directory for transfer.sh
- Create transfer.sh service in docker
- Expose the transfer.sh web GUI with traefik

## Requirements

- Should be distribution agnostic
- Ansible >= 2.10 (Tested on 2.10)
- traefik role should be started somewhere else

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `transfer_domain`

- Type: `string`
- Default: `t.holi0317.net`

Domain for hosting transfer.sh

## Dependencies

- bootstrap role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "transfer"
```

## License

MIT
