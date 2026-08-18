# Design: Public ingress and tailnet services

**Status:** Proposed

This document defines the planned ingress architecture for the Athena
homelab. It covers public HTTP ingress, private tailnet access, generated
configuration, Tailscale Services, and short go-link redirects. It does not
implement the resources yet.

## Decision summary

Use **Caddy** as the public HTTP reverse proxy and use **Tailscale Services**
as the private, tailnet-facing service layer.

Caddy owns:

- public HTTP and HTTPS listeners;
- public DNS host routing;
- public ACME certificates;
- HTTP middleware and application-specific proxy behavior;
- backend load balancing and health checks;
- generated configuration and graceful reloads.

Tailscale Services owns:

- stable private service identities;
- TailVIP and MagicDNS service addresses;
- tailnet access control and grants;
- service-host approval and advertisement;
- future multi-host routing for internal services;
- tailnet-facing HTTPS certificates for `*.ts.net` service names.

The two systems are complementary. Tailscale Services is not the public
internet ingress, and Caddy is not the source of truth for tailnet identity or
tailnet authorization.

## Why Caddy

The repository previously used Traefik with container labels. That design is
operationally familiar, but route definitions become scattered across
application container definitions. This makes the public surface difficult to
discover and encourages application lifecycle files to own edge policy.

Caddy is a better fit for the desired ownership model because its native JSON
configuration is designed to be generated programmatically. The repository
will maintain a readable, typed ingress inventory and generate Caddy JSON as a
deterministic artifact.

Caddy provides the required proxy capabilities:

- automatic public HTTPS;
- reverse proxying;
- active and passive health checks;
- load-balancing policies;
- retries and failover;
- graceful, zero-downtime configuration reloads.

The public Caddy container must not use the rootful Podman API socket. Route
discovery is intentionally explicit and generated rather than inferred from
container labels.

## Request paths

A public application exposed through both networks has two front doors:

```text
Public internet
  -> nc.holi0317.net:443
  -> Caddy public listener
  -> application frontend

Tailnet
  -> nextcloud.<tailnet-name>.ts.net:443
  -> Tailscale Service svc:nextcloud
  -> Caddy tailnet listener or application endpoint
  -> application frontend
```

The public and private hostnames are normally different. This avoids split-DNS
complexity and makes the trust boundary visible to users and operators.

A future split-DNS configuration may make a public hostname resolve to a
TailVIP for tailnet clients, but that is not the initial design.

## Podman networking

Caddy and public application frontends communicate over Podman bridge
networks. Backends do not publish public host ports.

The default layout is:

```text
ingress.network
  caddy
  nextcloud-web
  gitea
  authentik

nextcloud.network
  nextcloud-web
  nextcloud-fpm
  nextcloud worker services

postgres.network
  postgres
```

Only frontend containers join `ingress.network`. Postgres, Valkey, FPM, and
other internal services remain on private application networks.

Caddy addresses an upstream by a stable container name or network alias, for
example:

```text
http://nextcloud-web:80
```

This is an internal Podman DNS name. It is not a public host port.

An application frontend may join both its private application network and the
shared ingress network:

```ini
[Container]
ContainerName=nextcloud-web
Network=nextcloud.network
Network=ingress.network
NetworkAlias=nextcloud-web
```

The network must retain Podman bridge DNS. If stronger frontend-to-frontend
network isolation becomes necessary, Caddy can instead join one frontend
network per application, but the shared frontend network is the initial
choice.

## Caddy Quadlet

Caddy is managed as a rootful system Quadlet through
`@holi0317/systemd/quadlet`.

The planned container has:

- public host ports `80` and `443`;
- a persistent `/data` directory for certificates and Caddy state;
- a persistent `/config` directory;
- a read-only bind mount of a host configuration directory;
- no public admin API port;
- a `ReloadCmd` that invokes `caddy reload` through `systemctl reload`.

Conceptually:

```ini
[Container]
Image=docker.io/library/caddy:2.11.4-alpine
ContainerName=caddy
Network=ingress.network
PublishPort=80:80
PublishPort=443:443
Volume=/srv/persistent/caddy/data:/data:Z
Volume=/srv/persistent/caddy/config:/etc/caddy:ro,Z
Command=caddy run --config /etc/caddy/caddy.json --adapter json
ReloadCmd=caddy reload --config /etc/caddy/caddy.json --adapter json
```

`ReloadCmd` causes Quadlet to generate an `ExecReload` that runs `podman exec`
inside the container. The operational command is therefore:

```sh
systemctl reload caddy.service
```

A systemd `daemon-reload` is only required when the Quadlet source changes. A
normal Caddy configuration update must not restart the container.

## Configuration deployment

The repository source of truth is a typed ingress inventory, not hand-written
Caddy JSON.

A configuration apply follows this sequence:

1. Render deterministic Caddy JSON locally.
2. Validate the generated JSON with Caddy.
3. Upload a candidate file to the remote config directory.
4. Validate the candidate on Athena using the same Caddy image/runtime.
5. Atomically rename the candidate to `caddy.json`.
6. Run `systemctl reload caddy.service`.
7. Confirm the active configuration and record its digest.
8. Restore the previous known-good file if reload fails.

The container should bind-mount the **configuration directory**, not an
individual file. The model can then stage:

```text
/srv/persistent/caddy/config/caddy.json.next
```

and atomically rename it to:

```text
/srv/persistent/caddy/config/caddy.json
```

This avoids partial reads and individual-file bind-mount inode behavior.

Caddy's admin API remains an implementation detail of `caddy reload`; it is
not exposed to the network. The Caddy documentation states that `caddy reload`
is the semantic configuration-reload operation and that an invalid new config
leaves the previous active configuration running.

The model must still restore the previous file after a failed reload. Otherwise
a later container restart could load the failed candidate from disk.

## Caddy configuration ownership

The planned route inventory represents logical application exposure rather than
container labels:

```yaml
sites:
  - name: nextcloud
    public:
      host: nc.holi0317.net
      upstreams:
        - nextcloud-web:80
    tailnet:
      service: svc:nextcloud
      host: nextcloud.<tailnet-name>.ts.net
      upstreams:
        - nextcloud-web:80
```

Each site may define:

- public and/or tailnet hostnames;
- upstream names and ports;
- TLS policy;
- middleware;
- health checks;
- retry and load-balancing policy;
- application-specific forwarded headers;
- whether the site is public, tailnet-only, or disabled.

Public exposure is opt-in. There is no default route that exposes every
container.

## Tailnet access through Tailscale Services

A Tailscale Service is a logical private service with a stable MagicDNS name,
TailVIP addresses, grants, and one or more Service hosts.

A service is identified in configuration and grants as:

```text
svc:nextcloud
```

Users access it using its fully qualified MagicDNS hostname, for example:

```text
https://nextcloud.<tailnet-name>.ts.net
```

The `svc:` name is not the browser URL.

The initial internal route should use Tailscale HTTPS termination and forward
to a loopback-only Caddy listener. This keeps Caddy responsible for backend
routing and middleware while Tailscale owns tailnet TLS and authorization.

Conceptually:

```text
Tailnet client
  HTTPS to nextcloud.<tailnet-name>.ts.net
  -> Tailscale Service certificate and policy
  -> 127.0.0.1:<caddy-tailnet-port>
  -> Caddy internal route
  -> nextcloud-web
```

The alternative is to forward the Tailscale Service directly to a
loopback-published application port. That is simpler but duplicates some
routing and application-host configuration outside Caddy.

### Tailscale certificates

When a Service host uses an HTTPS Serve endpoint, Tailscale provisions the
certificate for the Service's `*.ts.net` hostname. This requires MagicDNS and
HTTPS certificates to be enabled in the tailnet.

This certificate is separate from Caddy's public certificate:

```text
nc.holi0317.net                  -> Caddy/ACME certificate
nextcloud.<tailnet-name>.ts.net  -> Tailscale-managed certificate
```

The Tailscale certificate does not cover a custom public hostname, and Caddy's
public certificate does not cover the Tailscale Service hostname.

Tailscale HTTPS certificates use publicly trusted certificates, so the
associated machine or service names appear in Certificate Transparency logs.
Service names must not contain sensitive information.

Raw TCP forwarding is not the default for web services. With raw TCP, Tailscale
does not terminate the web TLS connection and the backend must supply its own
certificate. Use HTTPS proxy mode for ordinary HTTP applications.

### Service host requirements

Tailscale requires a Service host to use a tag-based identity. Athena's current
Swamp SSH definition uses Tailscale transport for SSH, but that does not prove
that Athena is authenticated with an appropriate tag-based identity for
Services.

Before implementing Service advertisements, confirm:

- the installed Tailscale client is new enough;
- Athena has a tag-based identity such as `tag:service-host`;
- Service advertisements are approved or covered by an auto-approval policy;
- grants permit the intended users and devices to reach each service.

Tailscale clients at current supported versions receive Service routes without
requiring general subnet-route acceptance. Older Linux clients may require
`--accept-routes`.

## Declarative Tailscale configuration

Tailscale supports a local JSON Service-host configuration. A generated
configuration can contain entries such as:

```json
{
  "version": "0.0.1",
  "services": {
    "svc:nextcloud": {
      "endpoints": {
        "tcp:443": "http://127.0.0.1:18080"
      }
    }
  }
}
```

The documented workflow is:

```sh
tailscale serve set-config --all serveconfig.json
tailscale serve status --json
tailscale serve advertise svc:nextcloud
```

Service changes should drain the existing advertisement before removing or
changing an endpoint:

```sh
tailscale serve drain svc:nextcloud
```

The Tailscale Service definition itself is a control-plane resource created in
the Tailscale admin console or API. The local Service-host endpoint and
advertisement are separate concerns.

The repository currently has no local model dedicated to Tailscale Services.
Registry candidates must be inspected before implementation; a model that only
manages ordinary TCP Serve rules is not automatically sufficient for Service
creation, advertisement, draining, and status.

## Go links

Go links are tailnet-only redirects from a short service name:

```text
http://go/nextcloud
```

to:

```text
https://nextcloud.<tailnet-name>.ts.net
```

The planned implementation is a Tailscale Service named:

```text
svc:go
```

It exposes an HTTP endpoint to a loopback-only Caddy redirect listener. The
link map is generated centrally:

```yaml
goLinks:
  nextcloud: https://nextcloud.<tailnet-name>.ts.net
  gitea: https://gitea.<tailnet-name>.ts.net
```

The redirect listener uses exact paths by default. A temporary `302` status
may be used during testing; stable links should use `308`.

The bare string `go/nextcloud` is client-dependent. A client must resolve the
single-label hostname `go`, and browsers may treat a bare hostname without a
scheme as a search query. The reliable forms are:

```text
http://go/nextcloud
https://go.<tailnet-name>.ts.net/nextcloud
```

HTTPS cannot reliably use the bare hostname because Tailscale's certificate is
for `go.<tailnet-name>.ts.net`, not `go`.

## Model and workflow boundaries

The eventual implementation should preserve these boundaries:

```text
@holi0317/systemd/quadlet
  owns Caddy and Podman network lifecycle

Caddy configuration model
  owns ingress inventory rendering, validation, file deployment,
  graceful reload, applied digest, and rollback state

Tailscale Service-host model
  owns local Serve JSON, endpoint configuration, advertisement,
  drain, and status

Tailscale control-plane resource
  owns Service definition, TailVIP identity, tags, and grants

workflow-machine-ingress
  orders network, Caddy, config, applications, and Service advertisements
```

Remote model operations must use the repository's shared
`@holi0317/remote-ssh` adapter and ultimately the `@swamp/ssh` fleet model.
Custom models must not invoke local `ssh`, `scp`, `rsync`, or private SSH pools.

The workflow, not the Caddy or Tailscale model, owns ordering between
resources.

## Security requirements

- Do not mount the rootful Podman API socket into Caddy.
- Do not expose Caddy's admin API publicly or on the ingress network.
- Publish only Caddy ports `80` and `443` to the public host interface.
- Keep application, database, cache, and FPM ports private.
- Expose public sites explicitly; no container auto-discovery.
- Trust Tailscale identity headers only on a loopback-only trusted path.
- Store ACME state and Caddy data under persistent storage with restricted
  permissions.
- Store Tailscale control-plane credentials and any DNS credentials in vaults.
- Treat public and tailnet hostnames as separate security policies.
- Drain Tailscale Service hosts before endpoint replacement or removal.
- Validate generated configurations before changing the active file.
- Restore the prior known-good configuration after an unsuccessful reload.

## Non-goals

This design does not initially provide:

- high availability for public ingress on the single Athena host;
- automatic discovery of arbitrary Podman containers;
- a public Tailscale Funnel endpoint;
- split DNS for public hostnames;
- a general-purpose URL-shortener database or UI;
- public access to Tailscale Services;
- a replacement for application authentication.

## Implementation order

1. Confirm Athena's Tailscale version, tag identity, HTTPS enablement, and
   Service-host approval policy.
2. Define the ingress network and Caddy Quadlet.
3. Implement Caddy configuration rendering and validation.
4. Deploy Caddy with a minimal health endpoint and one test route.
5. Add the Nextcloud frontend and shared ingress network.
6. Add public Nextcloud routing and public ACME validation.
7. Define and advertise `svc:nextcloud` with a tailnet HTTPS endpoint.
8. Add tailnet-specific Caddy routing and verify both certificates and access
   policies.
9. Add the `svc:go` redirect service and centrally generated go-link map.
10. Migrate remaining applications one at a time.

## References

- [Repository master plan](./master-plan.md)
- [Model design principles](./model-design-principles.md)
- [Shared remote execution](./remote-execution.md)
- [Systemd model family](./systemd-extension.md)
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Caddy configuration API](https://caddyserver.com/docs/api)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Podman bridge networks](https://docs.podman.io/en/latest/markdown/podman-network-create.1.html)
- [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
- [Tailscale Services](https://tailscale.com/docs/features/tailscale-services)
- [Tailscale Services GA](https://tailscale.com/blog/services-ga)
- [Tailscale HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
