# Navidrome

Setup [navidrome] service, a music streaming service, in docker

[navidrome]: https://www.navidrome.org/

## Synopsis

- Create navidrome service in docker
- Expose the navidrome web GUI with traefik

## Requirements

- Should be distribution agnostic
- Ansible >= 2.11 (Tested on 2.11)
- traefik role should be started somewhere else

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `navidrome_domain`

- Type: `string`
- Default: `music.holi0317.net`

Domain for hosting navidrome

## Dependencies

- bootstrap role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "navidrome"
```

## License

MIT
