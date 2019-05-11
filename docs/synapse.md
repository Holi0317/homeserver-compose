# docker-compose for synapse

[Synapse] is a reference implementation of server under [matrix] network.

[Synapse]: https://github.com/matrix-org/synapse
[matrix]: https://matrix.org/

__NOTE__: This section of the docker-compose file is still work in progress.
Some features in matrix, namely VoIP may not be available yet.

## First run

### Set up required database user
We need to set up a postgres user for synapse for it to run.

First, start postgres before starting any other containers:

```bash
docker-compose up postgres
```

Obtain a shell by executing in another terminal

```bash
docker-compose exec postgres /bin/bash
```

In the new shell, run the following command

```bash
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE USER matrix;
    ALTER USER matrix WITH PASSWORD '';
    CREATE DATABASE synapse;
    GRANT ALL PRIVILEGES ON DATABASE synapse TO matrix;
EOSQL
``````


Replace `'``'` on 3rd line with a generated password. This password would be
the user password in postgres.

Update `SYNAPSE_DB_PASSWORD` variable to the password in `.env` file.

### Directory preparation

Create a directory under `${BASE_DIR}/synapse-data`. Change the owner of the
directory to `2000:2000`.

### Configuration generation

Run the following command

```bash
docker-compose run --rm synapse generate
```

This will generate configuration file `homeser.yml` to `${BASE_DIR}/synapse-data`.

To amend configuration later, directly modify the generated yml file.

## Register new user

Start a one-off synapse instance with registration on before actual synapse
is run.

```bash
docker-compose run -e SYNAPSE_ENABLE_REGISTRATION=1 synapse
```

Register using a matrix client. Then terminate the process after registration.

## Set an account as admin

Adapted from [Official synapse doc](https://github.com/matrix-org/synapse/blob/master/docs/admin_api/README.rst).

Synapse could be running or powered off. But postgres must be running for the modification.

Get a postgres shell by running the following commands

```bash
# In the host
docker-compose exec postgres /bin/bash
# In the spawned shell in container
psql --username "$POSTGRES_USER"
```

Then run the following command to connect to synapse database and list all
users.

```sql
\c synapse;
SELECT name, admin FROM users;
```

To update a user, use the following SQL command:

```sql
UPDATE users SET admin=1 WHERE name='@name:example.com';
```

Obviously, replace the name with matrix ID.
