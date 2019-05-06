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
directory to `991:991`.

## Register new user

Start a one-off synapse instance with registration on before actual synapse
is run.

```bash
docker-compose run -e SYNAPSE_ENABLE_REGISTRATION=1 synapse
```

Register using a matrix client. Then terminate the process after registration.
