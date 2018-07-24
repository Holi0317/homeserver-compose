# Homeserver compose
My homeserver docker-compose file and their documentation.

__NOTE__: I am not an official maintainer of any of the project used here.

Following services are available:
 - [Nextcloud](nextcloud.md)

## WARNING FOR BREAKING CHANGES
If you choose to use this configuration file, please be noted that I may introduce breaking changes
now and then without notice. Migration guide would _NOT_ be provided. Only initial setup guide is guaranteed
to be updated with configuration changes.

## Navigation
Other than the provided `docker-compose.yml` file, this repository also serves as a collection
of documentation for setting up services for _my use case_. Here are some general advice for
"How to use this repository".

 1. If you want to replicate my set up, read through __ALL__ documents and look for setup guide.
    I am not making a separate "quickstart guide" because you __must__ understand how to manage
    all service before deploy. There is no "set and forget" in hosting world.
 2. It is _highly recommended_ to fork this repository if you wish to use my setup. Because I will not provide
    support on migration between commits.
 3. Documentation for each services are provided under `docs/` directory, including what they depends and their
    configuration file. In case of any failure, consult the service documentation and look for solution.
 4. For documentation that does not belongs to any service (Like `.env` configuration file), they would be placed
    under repository root. Usually you only need to read them when initializing your setup.

## General docker-compose command reminder
```bash
# Start all services
docker-compose up -d

# Stop all services
docker-compose stop

# Remove all services container
docker-compose down

# Check logs
docker-compose logs -f
```
