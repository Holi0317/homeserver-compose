# airsane

Configure airsane to expose sane as airscan service.

## Synopsis

- Compile airsane
- Install airsane
- Enable airsane

## Requirements

- Ansible >= 2.13 (Tested on 2.13)
- Fedora
- sane to be enabled

## Role Variables

None

## Dependencies

Please run sane before this role.

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "airsane"
```

## License

MIT
