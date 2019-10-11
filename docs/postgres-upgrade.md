# Upgrading major version of postgreSQL

Upgrading postgreSQL is tricky. Especially in docker environment as the [pg_upgrade] script
requires the binary of both old and new version of postgreSQL.

Luckily, there are some effort for making upgrade in docker easier and manageable.

[pg_upgrade]: https://www.postgresql.org/docs/current/pgupgrade.html

## Preparation

### Backup and rename folder

Backup using [pg_dump]. Then rename the database directory.

In this example, we will simulate upgrading from version 11 to 12.

The directory for old database file is `dbdata-11` and the new one is `dbdata-12`.

[pg_dump]: https://www.postgresql.org/docs/current/app-pgdump.html

The new database folder could be empty as the docker container will initialize new database.

### Fix permission

Seems that the script will fix permission for us. But for the reference, change all folders
and files owner and group to `999:999` in both old and new database folder.

## Execution

We will be using [tianon/docker-postgres-upgrade] container for upgrade.

[tianon/docker-postgres-upgrade]: https://github.com/tianon/docker-postgres-upgrade

Run the following script

```bash
docker run --rm \
  -e PGUSER=mr_root -e POSTGRES_INITDB_ARGS="-U mr_root" \
  --mount type=bind,source="$(pwd)/dbdata-11",target=/var/lib/postgresql/11/data \
  --mount type=bind,source="$(pwd)/dbdata-12",target=/var/lib/postgresql/12/data \
  tianon/postgres-upgrade:11-to-12
```

Change version number accordingly for actual upgrade combination.

Note that we have added a few environment variables as we are not using `postgres` as root
user name. See the description in [tianon/docker-postgres-upgrade#10].

[tianon/docker-postgres-upgrade#10]: https://github.com/tianon/docker-postgres-upgrade/issues/10#issuecomment-523020113

## Post-upgrade

### Permission

Remember we used `999:999` for owner and group? Revert those change and use `2000:2000` for owners.

### Fixing pg_hba.conf error

pg_upgrade will not touch the `pg_hba.conf` file. While there's some script changed that file
in order to make things to work.

After upgrading, diff the `pg_hba.conf` file and update new file accordingly. Otherwise, services may
fail to connect to database.
