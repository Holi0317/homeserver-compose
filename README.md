# Ansible playbooks for building homelab

The repository is named with compose as the server was built with docker compose.
Now it has fully migrated to ansible. For the old docker compose files, check
the git tree at [5112411c].

[5112411c]: https://gitlab.com/holi0317/homeserver-compose/-/tree/5112411ceddd0e08aea83dda6cbb7b549e282f96

# Firewall configuration

Follow [ufw-docker] and install the script. After that restart ufw and docker.

[ufw-docker]: https://github.com/chaifeng/ufw-docker

# Create random ansible

> Assumes `pwgen` is available on system

```bash
pwgen 20 1 | tr -d '\n' | ansible-vault encrypt_string -n asdf
```
