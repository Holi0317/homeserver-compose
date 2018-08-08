# Gitea in docker
[Gitea](https://gitea.io/en-us/) is a self-hosted git server written in Go language.

This document will guide how to set up Gitea service.

## First run
Start up postgres instance before adding database user for gitea

```bash
docker-compose up postgres
```

Start another terminal and execute:

```bash
docker-compose exec postgres /bin/bash
```

When a new shell starts up, execute the following commands in container:

```bash
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE USER gitea;
    ALTER USER gitea WITH PASSWORD '';
    CREATE DATABASE gitea;
    GRANT ALL PRIVILEGES ON DATABASE gitea TO gitea;
EOSQL
```

Replace `''` on third line with a random password for gitea user.
Remember this password. We need it for gitea startup.

Kill both process after the command finish.

### Gitea initialization
```bash
docker-compose up -d
```

This should start all services in this package.

Navigate to domain specified in `GITEA_HOST` and press login.
A setup page should be shown. Input the following information:

 - Database password: the password above
 - SSH port: 0 (Disable)
 - Administrator account information

Then check for the form to see if there is any incorrect information (e.g. Host address)

## Editing gitea configuration
The `app.ini` file is located in `${BASE_PATH}/gitea/gitea/app.ini`. Edit it and restart gitea service should update configuration.

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
