# peertube

Setup [peertube] service in a docker container

[peertube]: https://joinpeertube.org/

## Synopsis

- Create postgres service with postgres role
- Create redis service with redis role
- Create configuration file for peertube
- Create peertube service in container
- Expose peertube with traefik

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

### `peertube_domain`

- Type: `string`
- Default: `pt.holi0317.net`

Domain for hosting peertube. This should not starts with "http" or "https".

Note that peertube does not officially support change in domain. In case of changed
domain, reset the data directory before doing so (and remember to backup).

## Dependencies

- bootstrap role
- postgres role
- redis role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "peertube"
      vars:
        postgres_password: "hunter2"
```

## License

MIT
