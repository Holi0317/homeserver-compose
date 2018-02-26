# Nextcloud compose
Run nextcloud in docker environment, using docker-compose

## Introduction
This is a docker compose configuration for [nextcloud]. This include:
 - Nginx as proxy
 - SSL certificate from Let's encrypt
 - PostgreSQL for database

Major aims of this README is to remind me and assist my debugging in the future.
Some information may get outdated but this document may not update.

## Requirement
 - [Docker]
 - [docker-compose]
 - [local-presist]

[Docker]: https://www.docker.com/
[docker-compose]: https://docs.docker.com/compose/
[local-presist]: https://github.com/CWSpear/local-persist

## Configuration
Copy the following to file `.env` on this directory and fill in information.

```bash
# Host name to be deployed
# By default, localhost:{80,443} will also be served
HOST=

# Email for registering lets encrypt
EMAIL=

# Base path of all files
# THERE IS NO TAILING SLASH
# `/nextcloud`, NOT `/nextcloud/`
BASE_PATH=
```

## Build or update
```bash
docker-compose build --pull
```

In case of full rebuild, add `--no-cache` flag to build command.

## First run
### Database initialization
Postgres need extra setup on first run.

First, spin up Postgres in root in order to create database properly.
(Replace `INSERT_RANDOM` with some random string)

```bash
docker-compose run -u root --rm -e POSTGRES_PASSWORD=INSERT_RANDOM db
```

Terminate the process after init process completed.

Then, we need to add database user for nextcloud. Run the following command to start database.

```bash
docker-compose up db
```

Start another terminal and execute:

```bash
docker-compose exec db /bin/bash
```

When a shell starts up, execute the following commands in contianer:

```bash
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE USER nextcloud;
    ALTER USER nextcloud WITH PASSWORD '';
    CREATE DATABASE nextcloud;
    GRANT ALL PRIVILEGES ON DATABASE nextcloud TO nextcloud;
EOSQL
```

Replace `''` with a random password for nextcloud user. We will not use superuser in the app.

Kill both process after the command finish.

### Nextcloud initialization
```bash
docker-compose up -d
```

This should start all services and the web server is ready to go.

On first run, nginx-proxy will generate a key and may cause spike. After that, the system should have lower load.

Navgate, on your browser, to localhost or the domain on `HOST` in `.env`. On the setup page, fill in following information:

 - Admin user and password: As you like
 - Data folder: `/var/data`
 - Database: PostgreSQL
 - Database user: `nextcloud`
 - Database password: Password used in database initialization
 - Database name: `nextcloud`
 - Database host: `db:5432`

### Nextcloud configuration
After setting up, go to configuration page and change the following settings:
 - Basic settings -> Background jobs: Cron
 - Additional settings -> Email server
 - Additional settings -> Maximum upload size

Edit `${BASE_PATH}/appasset/config/config.php` on host as root. Add `'enable_previews' => false,`
to line before last line.

## In case of...
### Forgot database password
After starting up all services, [get shell access to postgresql](#get-sql-shell-access).
(Replace NEW\_PASSWORD with new password, obviously)

```sql
ALTER USER nextcloud WITH PASSWORD 'NEW_PASSWORD';
```

### Reset nextcloud
To change data path inside container, nextcloud installation must be reset.

1. Stop all services
2. Remove nextcloud data by clearing `${BASE_PATH}/appasset` and `${BASE_PATH}appdata`
3. Start all services
4. Drop SQL database by `DROP DATABASE nextcloud;`
5. Create database by `CREATE DATABASE nextcloud;`
6. Grant permission: `GRANT ALL PRIVILEGES ON DATABASE nextcloud TO nextcloud;`

### Move storage location on host
Not to be confused with container location.

1. Stop all services
2. Move `${BASE_PATH}/appdata` to new location on host
3. Change docker-compose.yml `volume.appdata.driver_opts.mountpoint` to new location
4. Start all services

Resetting nextcloud is not required in this process.

## Control commands
In case I forget commands for docker-compose

### Get SQL shell access
Requirement: Database service must be running

```bash
docker-compose exec db /bin/bash
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER"
```

## occ (OwnCloud console)
`occ` is the command interface for managing nextcloud instance. Especially for maintenance work.
See [documentation](https://docs.nextcloud.com/server/13/admin_manual/configuration_server/occ_command.html).

```bash
docker-compose exec -u www-data app php occ
```

### Compose commands
```bash
# Start all services
docker-compose up -d

# Stop all services
docker-compose stop

# Remove all services container
docker-compose down

# Check logs
docker-compose logs -f
```
