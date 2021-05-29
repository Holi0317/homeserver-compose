# Piwigo

Setup [piwigo] service in docker

[piwigo]: https://piwigo.org/

## Synopsis

- Create maria database with maria role
- Create piwigo service in docker
- Expose the piwigo web GUI with traefik

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

### `piwigo_domain`

- Type: `string`
- Default: `piwigo.holi0317.net`

Domain for hosting piwigo

## Initial setup

We need to do some manual initial setup for this service as there is no easy way
of skipping it (or pre-fill some important information).

After first setup, navigate to the url and you'll be greeted with the installation
form.

Fill in the following information

- Database configuration
  - Host: `maria`
  - User: `piwigo`
  - Password: The `maria_password` used in playbook. Forgot? Try get it with
    `docker container inspect piwigo_maria | grep MARIADB_PASSWORD`
  - Database name: `piwigo`
  - Database tables prefix: Whatever. Default looks fine
- Administration configuration
  - Username: Whatever
  - Password: Whatever
  - Email: Whatever
  - Send my connection settings by email: Uncheck it. We don't have mail server here

## Dependencies

- bootstrap role
- maria role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "piwigo"
      vars:
        maria_password: "hunter2"
```

## License

MIT
