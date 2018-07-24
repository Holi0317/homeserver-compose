# docker-compose.yml for postgreSQL
Run PostgreSQL in docker environment. Providing database service for other docker services.

This service should _NOT_ be accessed by the public.

## First run -- database initialization
Before starting any services, postgreSQL need to be initialized with root privilege. After the process
is done, we could run postgreSQL in non-root user.

Replace `INSERT_RANDOM` with some random string and run the following command for initialization.

```bash
docker-compose run -u root --rm -e POSTGRES_PASSWORD=INSERT_RANDOM postgres
```

After the process has completed, terminate (`^C`) the process.

If you forgot to run the command above and started postgres service, you have to reset database file
and run initialization command again.

Stop all services and remove directory `${BASE_PATH}/dbdata` for reset postgres.

After database is initialized, follow other guides for setting up database user for their service.
Services need a database (Not guaranteed up to date):
 - [Nextcloud](nextcloud.md)

## Get SQL shell access
Remember to start postgres service before running the command.

```bash
docker-compose exec db /bin/bash
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER"
```

This would start a psql shell for super user in postgres, even if you you forgot the password.

## Reset SQL user password
Get a [shell access](#get-sql-shell-access) and run the following SQL.

```sql
ALTER USER poor_user_forgot_password WITH PASSWORD 'NEW_PASSWORD';
```

Replace `poor_user_forgot_password` with SQL user to reset. Usually it is the name of service using it.
