# Traefik service

[Traefik] is a reverse proxy for routing outbound traffic to docker system

[Traefik]: https://containo.us/traefik/

Any HTTP service requires this service to be started for serving in the 
Internet.

# Configuration - Firewall

The following ports need to be exposed:

 - `80/tcp`: HTTP traffic
 - `443/tcp`: HTTPS traffic

Do not expose port 8080 to public internet. That should be kept private.

# Starting

```bash
docker-compose up -d
```

# Provided endpoints

`localhost:8080`: Traefik daskboard
