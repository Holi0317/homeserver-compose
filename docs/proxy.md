# docker-compose.yml for proxy
Nginx reverse proxy for all web services.

This service will generate certificate from let's encrypt and serve as
a reverse proxy for network outside to access services.

Nearly all values are hard-coded in build time. For adding new services
or other modification, please edit the template file located in `build/proxy/default`.
