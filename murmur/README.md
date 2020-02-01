# Murmur

[Murmur] is a server for voice chat. The client is named [mumble].

[Murmur]: https://wiki.mumble.info/wiki/Running_Murmur
[mumble]: https://wiki.mumble.info/wiki/Main_Page

This document will guide how to setup murmur service

Note that murmur does not require [traefik] as it is not a HTTP service

[traefik]: ../traefik/README.md

# Configuration - Firewall

The following ports need to be exposed:

 - `64738/tcp`: murmur access
 - `64738/udp`: murmur access

# Configuration - First run

This repository stores no configuration for murmur. The configuration solely 
depends on editing configuration file in disk.

The config is stored in `${BASE_PATH}/murmur/config/murmur.ini`. Please check 
[official guide](https://wiki.mumble.info/wiki/Murmur.ini) for configurations 
available.

# Starting

```bash
docker-compose up -d
```

# Connection

In mumble, connect with port `64738`. Make sure firewall rule has been updated.

# Guides

## Get SuperUser password

The password for `SuperUser` is generated on-the-fly during first run of 
murmur. Check the log by `docker-compose logs murmur` and look for the line 
`Password for 'SuperUser' set to '***'`.

## Recommended configuration

- Set `serverpassword` to any login password
- Lower limit for `users`
- Disable `bonjour`
- Disable `sendversion`
- Disable `ice`
