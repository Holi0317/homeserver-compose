# wireguard

Setup wireguard server

## Synopsis

Setup a wireguard server on fedora (RHEL/CentOS may also work) server.

## Requirements

- Ansible >= 2.11 (Tested on 2.11)

## Role Variables

See `meta/argument_specs.yml`.

## Dependencies

None

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "wireguard"
      wg_port: 17178
      wg_address: "10.9.0.1/24"
      wg_private_key: "MY_PRIVATE"
      wg_peers:
        - address: "10.9.0.2/32"
          public_key: "HIS_PUBLIC"
```

## License

MIT
