# .envrc file

This project use [direnv] for configuration purpose.

We are not using [`docker-compose`'s
`.env`](https://docs.docker.com/compose/env-file) file because it does not
inherit configuration from parent folders.

You must create one before starting or building any service.

In case of missing environment variable, the docker-compose file will refuse to
run.

Setting up [direnv] is highly recommended. However, we are not using any
[direnv]-specific commands. Sourcing the `.envrc` file will still works.

[direnv]: https://direnv.net/

## Example environmental file

Copy content of following code block and save as `.envrc` at root directory of
the repository

Then fill in variables value following their comment description.

```bash
# Email for registering lets encrypt
export EMAIL=

# Base path of all files
# THERE IS NO TAILING SLASH
# e.g. `/srv/selfhost`, NOT `/srv/selfhost/`
export BASE_PATH=

# Password for gitea service's database
# Generate a random string here if gitea services will be started
# Otherwise leave this as blank
export GITEA_DB_PASS=

# Password for nextcloud service's database
# Generate a random string here if nextcloud services will be started
# Otherwise leave this as blank
export NC_DB_PASS=

# Password for peertube service's database
# Generate a random string here if peertube services will be started
# Otherwise leave this as blank
export PEERTUBE_DB_PASS=
```
