# Environmental file
This project use [environmental file] from docker-compose for storing some configuration.

You must create one before starting or building any service.

[environmental file]: https://docs.docker.com/compose/env-file/

## Example environmental file
Copy content of following code block and save as `.env` at same directory with `docker-compose.yml`.

Then fill in variables value following their comment description.

```bash
# Email for registering lets encrypt
EMAIL=

# Base path of all files
# THERE IS NO TAILING SLASH
# e.g. `/srv/selfhost`, NOT `/srv/selfhost/`
BASE_PATH=

# For all hostnames, use comma (without space) to separate multiple host names.

# Host name to be served for nextcloud service
NEXTCLOUD_HOST=

# Host name to be served for gitea service
GITEA_HOST=

# Host name to be served for polaris service
POLARIS_HOST=
```

## Note on hostname
All variable with `_HOST` suffix are hostname, which are host to listen to for each service.

Unless otherwise specified, all external facing services would be proxied by `nginx` in `proxy` service.
This implies the service could listen to multiple hostname. Use a `,`(without space) to separate the
hostnames to listen to.

__IMPORTANT__: After changing the hostname, shut down proxy service and _remove_ `${BASE_PATH}/conf.d/default.conf` and restart.
Sometimes proxy could not catch up changes and re-generate config for new hostname
