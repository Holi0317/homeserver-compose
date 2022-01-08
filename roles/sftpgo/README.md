# sftpgo

Setup [sftpgo] service in docker

[sftpgo]: https://github.com/drakkan/sftpgo/

## Synopsis

- Create sftpgo service in docker
- Expose the sftpgo web GUI with traefik to internal network

To expose sftp port to wireguard subnet, run the firewall playbook.

## Requirements

- Should be distribution agnostic
- Ansible >= 2.10 (Tested on 2.10)
- traefik role should be started somewhere else

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `sftpgo_domain`

- Type: `string`
- Default: `sftpgo.holi0317.net`

Domain for hosting sftpgo admin UI

### `sftpgo_sftp_port`

- Type: `integer`
- Default: `2022`

Port (exposed on host) for accepting sftp connection

### `sftp_admin_ip_whitelist`

- Type: `str`
- Default: `127.0.0.1/32,192.168.149.1/24`

List of CIDR ranges that can access the admin UI

## Dependencies

- bootstrap role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "sftpgo"
```

## License

MIT
