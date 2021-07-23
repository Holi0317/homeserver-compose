# Keycloak

Setup [keycloak] service in docker.

This only setup the keycloak server. No further configuration will be done.

The default login credential is user = `admin` and password = `admin`.
Change it after first login.

[keycloak]: https://www.keycloak.org/

## Synopsis

- Create postgres database with postgres role
- Create keycloak service in docker
- Expose keycloak frontend with traefik

## Requirements

- Should only support Fedora
- Ansible >= 2.11 (Tested on 2.11)
- Traefik should be started by other place

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `postgres_password`

- Type: `string`
- Required: Yes

(Inherited from postgres role) Password for the postgres database

### `keycloak_domain`

- Type: `string`
- Default: `auth.holi0317.net`

Domain for keycloak frontend interface

## Dependencies

- bootstrap role
- postgres role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "keycloak"
      vars:
        postgres_password: "hunter2"
```

## License

MIT
