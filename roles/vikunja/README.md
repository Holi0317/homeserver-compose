# vikunja

Setup [vikunja] service in docker

[vikunja]: https://vikunja.io/

## Synopsis

- Create postgres database with postgres role
- Create redis server with redis role
- Create vikunja api and frontend in docker
- Expose the vikunja api and frontend with traefik

## Requirements

- Should be distribution agnostic
- Ansible >= 2.10 (Tested on 2.12)
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

### `vikunja_domain`

- Type: `string`
- Default: `todo.holi0317.net`

Domain for hosting vikunja

### `vikunja_jwt_secret`

- Type: `string`
- Required: Yes

Random string for JWT encryption

### `smtp_host`

- Type: `str`
- Required: Yes

Hostname for SMTP server. This should **NOT** include the port number.

For example, `smtp.example.com` is a valid format.

### `smtp_port`

- Type: `str`
- Default: `587`

Port for SMTP server.

### `smtp_user`

- Type: `str`
- Required: Yes

Login user for SMTP server.

### `smtp_password`

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
    - role: "vikunja"
      vars:
        postgres_password: "hunter2"
        vikunja_jwt_secret: "hunter2"
        smtp_host: "smtp.example.com"
        smtp_user: "email_login"
        smtp_password: "hunter2"
```

## License

MIT
