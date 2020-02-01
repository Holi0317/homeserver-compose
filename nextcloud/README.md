# docker-compose for NextCloud

Run [nextcloud] in docker environment, using docker-compose

[nextcloud]: https://nextcloud.com/

# Introduction

There are 3 services for this module:

- nextcloud-fpm: [php-fpm]-based image for running php and cron job
- nextcloud: [nginx] reverse proxy for serving fpm and static assets
- postgres: Database for php

[php-fpm]: https://hub.docker.com/\_/php/
[nginx]: https://hub.docker.com/\_/nginx

# Configuration - Environment config

Ensure `NC_DB_PASS` is populated in `.envrc`

# Configuration - First run

## 1. Add host user accounts (optional)

In the images, `nextcloud (uid = 2000)` user would be used.
The host system may add nextcloud user for easier management in filesystem.

Check the documentation of your distribution for instruction on adding user.

 - uid: 2000
 - gid: 2000
 - group: nextcloud
 - Shell: nologin

## 2. Run initialize process of nextcloud

Start all services by:

```bash
docker-compose up -d
```

Remember to start traefik before proceeding

Navigate to `nc.holi0317.net` and setup page should be shown. Input following 
information. Some fields may be already filled:

 - Admin user and password: As you like
 - Data folder: `/var/data`
 - Database: `PostgreSQL`
 - Database user: `nextcloud`
 - Database password: `NC_DB_PASS` in `.envrc`
 - Database name: `nextcloud`
 - Database host: `postgres:5432`

## 3. Configure nextcloud

Set the following in nextcloud settings:

 - Basic settings -> Background jobs: Cron
 - Basic settings -> Email server

## 4. Edit `config.php`

Edit `${BASE_DIR}/nextcloud/asset/config/config.php` and append the following 
snippet to the end, before the line `);`

```php
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

Remark: I am not sure what to fill in to the `trusted_proxies` key as ip of the 
container should not be fixed.
Just remember to test reverse proxy is aware by nextcloud by issuing an invalid login and check the log.
If the log entry shows correct ip address, then the configuration should be fine.

# Configuration - Post-initialization

## Reset nextcloud

To change data path inside container, nextcloud installation must be reset.

This process is only necessary for *misconfiguration* in first run!

For correct configuration (with correct data folder set in setup), change data 
storage path would be:

1. Move all files to new destination
2. Change variable `$BASE_PATH` in `.envrc`

For misconfiguration, stop nextcloud and remove `${BASE_PATH}/nextcloud`. Then 
restart nextcloud and run configuration process

## Management command (occ)

`occ` is the command interface for managing nextcloud instance. Especially for 
maintenance work.
See [documentation](https://docs.nextcloud.com/server/13/admin_manual/configuration_server/occ_command.html).

```bash
docker-compose exec -u 2000 nextcloud-fpm php occ
```
