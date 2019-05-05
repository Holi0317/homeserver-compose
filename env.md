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
```
