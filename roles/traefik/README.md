# Traefik

Setup [traefik] service in docker.

[traefik]: https://traefik.io/traefik/

## Synopsis

- Build a traefik docker image with our own configuration
- Create docker network with name `traefik` for other services to attach into
  - The network will have subnet of `172.18.0.0/16`. Set the service to trust
    request from this subnet if required
- Create a docker container running traefik

## Requirements

- Should be distribution agnostic
- Ansible >= 2.10 (Tested on 2.10)

## Role Variables

| Variable        | Type             | Comment                                  |
| --------------- | ---------------- | ---------------------------------------- |
| `storage_root`  | string, required | Path prefix for all persistent data      |
| `traefik_email` | string, requried | Email for registering with let's encrypt |

A description of the settable variables for this role should go here, including any variables that are in defaults/main.yml, vars/main.yml, and any variables that can/should be set via parameters to the role. Any variables that are read from other roles and/or the global scope (ie. hostvars, group vars, etc.) should be mentioned here as well.

## Example Playbook

Including an example of how to use your role (for instance, with variables passed in as parameters) is always nice for users too:

```yaml
- hosts: "servers"
  roles:
    - role: "traefik"
      vars:
        traefik_email: "me@example.com"
```

## License

MIT
