# Bootstrap

Setup foundation for a service

## Synopsis

- Ensure docker is installed and started
- Create base directory `service_base_path` for the service
- Create "default" docker network `service_network` for the service
- Create `service_*` variables for dependant roles to use (See table below)

This role will use `service_*` variables as namespace.

Other roles may also use the variables here. Consult their documentation for details.

This should not be used in a playbook directly. Instead this role should be a dependency
for other roles.

## Requirements

- Distribution is Arch or Ubuntu. Others distribution can still run this role.
  But need to setup docker by themselves

## Input role variables

| Variable       | Type             | Comment                                                          |
| -------------- | ---------------- | ---------------------------------------------------------------- |
| `storage_root` | string, required | Path prefix for all persistent data                              |
| `service_name` | string, required | Name of the service to be setup. This should be set by the roles |

## Output role variables

We are using how ansible scope variables to "expose" these variables to the dependant
service. As there is no role-level scope in ansible, every variables defined in this role
will be exposed to the dependant roles. By using this trick, we can "export" computed
variables for dependant roles to use them.

Although possible, it is not recommended for overriding these variables in playbook level.

| Variable            | Type   | Comment                                               |
| ------------------- | ------ | ----------------------------------------------------- |
| `service_base_path` | string | Base path for the service's persistent data           |
| `service_network`   | string | Name of the "default" docker network for this service |

## Dependencies

None

## Example Playbook

```yaml
- hosts: "servers"
  vars:
    storage_root: "/srv/services"
  roles:
    - role: "bootstrap"
      vars:
        service_name: "gitea"
```

## License

MIT
