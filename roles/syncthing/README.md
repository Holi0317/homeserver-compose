# Syncthing

Setup [syncthing] service in docker

[syncthing]: https://syncthing.net/

## Note

For all folders, add them under `/var/syncthing` path for persistent.

## Synopsis

- Create syncthing service in docker
- Add `syncthing` service to `firewalld`, `FedoraServer` zone

## Requirements

- Should only support Fedora
- Ansible >= 2.11 (Tested on 2.11)
- Traefik should be started by other place

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

(Inherited from bootstrap role) Path prefix for all persistent data.

### `syncthing_domain`

- Type: `string`
- Default: `syncthing.holi0317.net`

Domain for syncthing interface

### `syncthing_ip_whitelist`

- Type: `string`
- Default: `127.0.0.1/32,192.168.149.1/24`

List of (comma separated) CIDR range or IP that can access the syncthing interface

## Dependencies

- bootstrap role

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "syncthing"
```

## License

MIT
