# Docker

Install docker ce engine

## Synopsis

- Install docker engine
- Enable and start systemd docker.service

## Requirements

- Distribution is Fedora or Ubuntu (Tested on Fedora only)
- Ansible >= 2.13 (Tested on 2.13)

## Dependencies

None

## Example Playbook

```yaml
- hosts: "servers"
  roles:
    - role: "docker"
```

## License

MIT
