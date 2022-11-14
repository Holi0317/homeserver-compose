# cups

Configure cups printing service

## Synopsis

- Install and start avahi (mdns)
- Install cups and brlaser driver
- Enable cups

## Requirements

- Ansible >= 2.13 (Tested on 2.13)
- Fedora
- Brother DCP-L2540DW printer

## Role Variables

None

## Dependencies

None

## Example Playbook

```yaml
- hosts: servers
  roles:
    - role: "cups"
```

## License

MIT
