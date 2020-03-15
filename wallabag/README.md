# Wallabag in docker

[Wallabag](https://www.wallabag.it/en) is a self-hosted read it later list

This document will guide how to set up Gitea service.

# Configuration - Environment config

Ensure all configuration starts with `WALLABAG` is populated in `.envrc`

Check `../docs/envrc.md` for details.

# Configuration - First run

```bash
docker-compose up -d
```

This should start all services in this package.

Remember to start [traefik] before proceeding.

Navigate to `bag.holi0317.net` and login. Default credential is `wallabag:wallabag`.
