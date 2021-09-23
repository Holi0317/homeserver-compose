# Gitea

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

Domain for hosting gitea

### `gitea_ssh_port`

- Type: `integer`
- Default: `17022`

Port for accepting ssh connection

### `gitea_smtp_host`

- Type: `str`
- Required: Yes

Hostname for SMTP server. This should also include the port number.

We assume TLS is enabled for the SMTP server.

### `gitea_smtp_user`

- Type: `str`
- Required: Yes

Login user for SMTP server.

### `gitea_smtp_password`

- Type: `str`
- Required: Yes

Login password for SMTP server.

## Dependencies

- bootstrap role
- postgres role
- redis role

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
