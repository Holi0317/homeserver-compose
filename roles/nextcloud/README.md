# Nextcloud

Setup [nextcloud] service in docker

[nextcloud]: https://nextcloud.com/

## Synopsis

- Create postgres database with postgres role
- Create redis cache with redis role
- Build customized nextcloud docker images
- Create nextcloud service in docker
- Expose the nextcloud web GUI with traefik

## Requirements

- Should be distribution agnostic
- Ansible >= 2.10 (Tested on 2.10)
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

### `nextcloud_domain`

- Type: `string`
- Default: `git.holi0317.net`

Domain for hosting gitlab

## Dependencies

- bootstrap role
- postgres role
- redis role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "nextcloud"
      vars:
        postgres_password: "hunter2"
```

## License

MIT
