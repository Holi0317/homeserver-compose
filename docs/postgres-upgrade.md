# Upgrading major version of postgreSQL

This documentation applies to services that requires postgreSQL database.
Including [nextcloud] and [gitea].

[nextcloud]: ../nextcloud/README.md
[gitea]: ../gitea/README.md

This documentation may not be fully accurate.

Upgrading postgreSQL is tricky. Especially in docker environment as the [pg_upgrade] script
requires the binary of both old and new version of postgreSQL.

Luckily, there are some effort for making upgrade in docker easier and manageable.

[pg_upgrade]: https://www.postgresql.org/docs/current/pgupgrade.html

# Preparation

## 1. Stop all services using the database

Just run `down` on the module

```bash
docker-compose down
```

## 2. Preparation - Backup postgres

Backup using [pg_dump]. Adopt the following snippet and run it:

```bash
docker-compose up -d postgres
docker-compose exec postgres pg_dump -U myuser -F t myser > dump.tar
docker-compose down
```

That would create a dump to `dump.tar`. Save it in case the migration failed.

[pg_dump]: https://www.postgresql.org/docs/current/app-pgdump.html

## 3. Preparation - Rename folder

The data folder for old and new postgres is expected to be different.

In this example, we will simulate upgrading from version 11 to 12.

The directory for old database file is `pg11` and the new one is `pg12`.

The new database folder could be empty as the docker container will initialize new database.

## 4. Preparation - Fix permission

Seems that the script is based on debian instead of alpine. Therefore postgres user is
at ID `999:999` instead of `70:70`.

Although the script will fix permission for us, we would like to play safe.
Change all folders and files permission to `999:999` in both new and old database folder

# Execution

We will be using [tianon/docker-postgres-upgrade] container for upgrade.

[tianon/docker-postgres-upgrade]: https://github.com/tianon/docker-postgres-upgrade

Run the following script (Assuming 11 to 12)

```bash
docker run --rm \
  -e PGUSER=myuser -e POSTGRES_INITDB_ARGS="-U myuser" \
  --mount type=bind,source="$(pwd)/pg11",target=/var/lib/postgresql/11/data \
  --mount type=bind,source="$(pwd)/pg12",target=/var/lib/postgresql/12/data \
  tianon/postgres-upgrade:11-to-12
```

Change version number accordingly for actual upgrade combination.

Replace `myuser` with the service name. We are using service name as the
username in database.

Note that we have added a few environment variables as we are not using `postgres` as root
user name. See the description in [tianon/docker-postgres-upgrade#10].

[tianon/docker-postgres-upgrade#10]: https://github.com/tianon/docker-postgres-upgrade/issues/10#issuecomment-523020113

# Post-upgrade

## Permission

Remember we used `999:999` for owner and group? Revert those change and use
`70:70` for owners.

## Folder rename

Rename the folder `pg12` to `postgres` so that compose file can reference to it correctly.

## Upgrade image tag in compose

Just upgrade the image tag to the new version. We are upgrading to a new version, right?

## Fixing pg_hba.conf error

pg_upgrade will not touch the `pg_hba.conf` file. While there's some script changed that file
in order to make things to work.

After upgrading, diff the `pg_hba.conf` file and update new file accordingly. Otherwise, services may
fail to connect to database.

That should add the following line at the end of the file:

```
host all all all md5
```

# Validate and remove backup

Try the running the service. If everything is fine, remove the old database folder and backup.
