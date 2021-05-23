# Role Name

Setup [gitea] service in docker

[gitea]: https://docs.gitea.io/en-us/

## Synopsis

- Create postgres database with postgres role
- Create gitea service in docker
- Expose the gitea web GUI with traefik

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

### `gitea_domain`

- Type: `string`
- Default: `git.holi0317.net`

Domain for hosting gitlab

### `gitea_ssh_port`

- Type: `integer`
- Default: `17022`

Port for accepting ssh connection

## Dependencies

- bootstrap role
- postgres role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "gitea"
      vars:
        postgres_password: "hunter2"
```

## License

MIT
