# Photoprism

Setup [photoprism] service in docker

[photoprism]: https://docs.photoprism.org/

## Synopsis

- Create maria database with maria role
- Create maria service in docker
- Create directories for photoprism
- Expose the maria web GUI with traefik

## Requirements

- Should be distribution agnostic
- Ansible >= 2.10 (Tested on 2.10)
- traefik role should be started somewhere else

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `maria_password`

- Type: `string`
- Required: Yes

(Inherited from maria role) Password for the maria database

### `photoprism_domain`

- Type: `string`
- Default: `pp.holi0317.net`

Domain for hosting photoprism

### `photoprism_admin_password`

- Type: `string`
- Required: Yes

Initial admin password for photoprism

## Dependencies

- bootstrap role
- maria role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "photoprism"
      vars:
        maria_password: "hunter2"
        photoprism_admin_password: "hunter2"
```

## License

MIT
