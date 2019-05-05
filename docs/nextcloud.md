# docker-compose for NextCloud
Run [nextcloud] in docker environment, using docker-compose

[nextcloud]: https://nextcloud.com/

## Introduction
This is a docker compose configuration for [nextcloud]. This include:
 - Nginx as proxy
 - SSL certificate from Let's encrypt
 - PostgreSQL for database

Major aims of this README is to remind me and assist my debugging in the future.
Some information may get outdated as this document is not maintained often.

## Requirement
 - [Docker]
 - [docker-compose]
 - [local-presist]

[Docker]: https://www.docker.com/
[docker-compose]: https://docs.docker.com/compose/
[local-presist]: https://github.com/CWSpear/local-persist

## First run

### Add host user accounts (optional)
In the images, `nextcloud (uid = 2000)` user would be used.
The host system may add nextcloud user for easier management in filesystem.

Check the documentation of your distribution for instruction on adding user.

 - uid: 2000
 - gid: 2000
 - group: nextcloud
 - Shell: nologin

Remember for setting up login shell for better security!

### Database user initialization
Start up postgres instance before adding database user for nextcloud

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
    CREATE USER nextcloud;
    ALTER USER nextcloud WITH PASSWORD '';
    CREATE DATABASE nextcloud;
    GRANT ALL PRIVILEGES ON DATABASE nextcloud TO nextcloud;
EOSQL
```

Replace `''` on third line with a random password for nextcloud user.
Remember this password. We need it for nextcloud startup.

Kill both process after the command finish.

### Nextcloud initialization
```bash
docker-compose up -d
```

This should start all services and the web server is ready to go.

Navigate, on your browser, to `nc.holi0317.net`. On the setup page, fill in the following information:

 - Admin user and password: As you like
 - Data folder: `/var/data`
 - Database: `PostgreSQL`
 - Database user: `nextcloud`
 - Database password: Password used in database initialization
 - Database name: `nextcloud`
 - Database host: `postgres:5432`

### Nextcloud configuration
After setting up, go to configuration page and change the following settings:
 - Basic settings -> Background jobs: Cron
 - Additional settings -> Email server
 - Additional settings -> Maximum upload size

### Nextcloud config.php modification
Edit `${BASE_DIR}/nextcloud-asset/config.config.php` and append the following snippet to the end, before the line (`);`)

```
  'csrf.optout' =>
  array (
    0 => '/^WebDAVFS/',
    1 => '/^Microsoft-WebDAV-MiniRedir/',
    2 => '/Thunderbird/',
    3 => '/^DAVdroid/',
  ),
  'trusted_proxies'   => ['172.30.0.0/24'],
  'overwriteprotocol' => 'https',
```

Remark: I am not sure what to fill in to the `trusted_proxies` key as ip of the container should not be fixed.
Just remember to test reverse proxy is aware by nextcloud by issuing an invalid login and check the log.
If the log entry shows correct ip address, then the configuration should be fine.

## In case of...
### Reset nextcloud
To change data path inside container, nextcloud installation must be reset.

This process is only necessary for misconfiguration in first run!
If you wish to change data storage path on host afterwards,
just copy all files to new destination and change variable in `.env`.

1. Stop all services
2. Remove nextcloud data by clearing `${BASE_PATH}/appasset` and `${BASE_PATH}/appdata`
3. Start all services
4. Run the following SQL commands (See [PostgreSQL documentation](postgres.md#get-sql-shell-access) for accessing psql shell)
```sql
-- Drop SQL Database
DROP DATABASE nextcloud;

-- Create new SQL Database
CREATE DATABASE nextcloud;

-- Grant permission to `nextcloud` user
GRANT ALL PRIVILEGES ON DATABASE nextcloud TO nextcloud;
```

### Move storage location on host
Not to be confused with container location.

1. Stop all services
2. Move `${BASE_PATH}/appdata` to new location on host
3. Change docker-compose.yml `volume.appdata.driver_opts.mountpoint` to new location
4. Start all services

Resetting nextcloud is not required in this process.

## Management commands

## occ (OwnCloud console)
`occ` is the command interface for managing nextcloud instance. Especially for maintenance work.
See [documentation](https://docs.nextcloud.com/server/13/admin_manual/configuration_server/occ_command.html).

```bash
docker-compose exec -u 2000 nextcloud php occ
```
