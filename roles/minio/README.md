# Minio

Setup [minio] service in docker.

[minio]: https://min.io/

## Synopsis

- Create minio service in docker

## Requirements

- Should only support Fedora
- Ansible >= 2.11 (Tested on 2.11)
- Traefik should be started by other place

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `minio_domain`

- Type: `string`
- Default: `minio.holi0317.net`

Domain for minio API

### `minio_console_domain`

- Type: `string`
- Default: `console.{{ minio_domain }}`

Domain for minio console

### `minio_user`

- Type: `string`
- Default: `minioadmin`

Login name for admin user

### `minio_password`

- Type: `string`
- Required: yes

Login password for admin user

## Dependencies

- bootstrap role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "minio"
      vars:
        minio_password: "hunter2"
```

## License

MIT
