# Gitea in docker

[Gitea](https://gitea.io/en-us/) is a self-hosted git server written in Go language.

This document will guide how to set up Gitea service.

# Configuration - Environment config

Ensure `GITEA_DB_PASS` is populated in `.envrc`

# Configuration - First run

```bash
docker-compose up -d
```

This should start all services in this package.

Remember to start traefik before proceeding.

Navigate to `git.holi0317.net` and press login.
A setup page should be shown where some config is pre-populated. Don't touch
them.

Fill in administrator account information on that page

Then check for the form to see if there is any incorrect information (e.g. Host address)

# Configuration - Post-initialization

## Editing gitea configuration

The `app.ini` file is located in `${BASE_PATH}/gitea/data/gitea/app.ini`.
Edit it and restart gitea service should update configuration.

Restart:

```bash
docker-compose restart gitea
```

## Get access to gitea CLI

[CLI Reference](https://docs.gitea.io/en-us/command-line/)

```bash
docker-compose exec -u 2000 gitea gitea
```

Append command (e.g. `web`, `admin`) to the end of the above snippet.

If no command is attached, a new server would be started.
