# docker-compose.yml for nextcloud-web
This service does not contain any interesting configuration or settings.
See [nextcloud](nextcloud.md) documentation instead.

## But...why do we have this service?
This service runs a `nginx` instance for nextcloud, serving static content (CSS, Javascripts, etc) for nextcloud web UI.

Or, because php does not start up its own server.

