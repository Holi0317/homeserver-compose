# Nextcloud

Setup [nextcloud] service in docker

[nextcloud]: https://nextcloud.com/

## Synopsis

- Create postgres database and role for nextcloud
- Create nextcloud web and cron service in docker
- Expose the nextcloud web GUI with traefik

## Requirements

- Ansible >= 2.16
- traefik role should be started somewhere else

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

Path prefix for all persistent data.

### `postgres_admin_password`

- Type: `string`
- Required: Yes

Admin (role `postgres`) password for postgres cluster, for managing db and role for
service.

### `nextcloud_pg_password`

- Type: `string`
- Required: Yes

Password for the postgres database, nextcloud_user

### `nextcloud_redict_db`

- Type: `string (with integer in it)`
- Required: Yes

Redict (redis fork) database (virtual host) number.

> [NOTE!]  
> This has to be `0`. Nextcloud docker image does not allow configuring redis virtual host

### `nextcloud_domain`

- Type: `string`
- Default: `nc.holi0317.net`

Domain for hosting nextcloud

## Dependencies

Following roles should be applied somewhere else

- traefik
- postgres
- redict

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "nextcloud"
      vars:
        postgres_admin_password: "hunter2"
        nextcloud_pg_password: "hunter2"
        redict_db: "0"
```

## License

MIT
