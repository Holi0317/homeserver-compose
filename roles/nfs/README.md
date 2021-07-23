# nfs

Setup nfs service.

Config for this is very hard-coded and there is no variable
for changing the behavior right now.

## Synopsis

- Install nfs packages
- Create nfs configurations
- Start nfs service

Note that firewall will not be configured

## Requirements

- Should only support Fedora
- Ansible >= 2.11 (Tested on 2.11)

## Role Variables

None

## Dependencies

None

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "nfs"
```

## License

MIT
