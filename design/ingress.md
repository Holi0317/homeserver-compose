# Design: Public Caddy ingress, Cloudflare DNS, and tailnet services

**Status:** Proposed

This document defines the planned ingress architecture for the Athena
homelab. It covers public HTTP ingress, Cloudflare DNS and DDNS, private
tailnet access, generated configuration, Tailscale Services, and short
go-link redirects. It does not implement the resources yet.

The rollout is intentionally split into two phases. Phase 1 establishes
Caddy as the public-internet edge and Cloudflare as authoritative DNS. Phase 2
adds Tailscale Services for private tailnet exposure after the public path is
stable; tailnet exposure is not a prerequisite for public ingress.

## Decision summary

Use **Caddy** as the public HTTP reverse proxy and **Cloudflare** as the
authoritative DNS provider for public hostnames. Use **Tailscale Services** as
a later, private tailnet-facing service layer.

Caddy owns:

- public HTTP and HTTPS listeners;
- public host routing;
- public ACME certificates;
- HTTP middleware and application-specific proxy behavior;
- backend load balancing and health checks;
- generated configuration and graceful reloads.

Cloudflare DNS owns:

- authoritative public DNS for the domain;
- explicitly managed public A and AAAA records;
- DDNS updates for records that follow Athena's public address.

Tailscale Services owns in the later phase:

- stable private service identities;
- TailVIP and MagicDNS service addresses;
- tailnet access control and grants;
- service-host approval and advertisement;
- future multi-host routing for internal services;
- tailnet-facing HTTPS certificates for `*.ts.net` service names.

The Cloudflare Caddy DNS provider module and the DDNS updater have different
responsibilities. The Caddy module can create temporary DNS-01 ACME challenge
records; it does not update the public A or AAAA records used for DDNS. Caddy
and Cloudflare DNS are the public-ingress phase, while Tailscale Services is a
later private-access phase.

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
container labels. If DNS-01 is required, the Caddy image must include a
pinned Cloudflare DNS provider module; that community module is not bundled
with stock Caddy.

## Cloudflare DNS and DDNS

Cloudflare is authoritative for the public zone. Public hostnames must have
explicit A and/or AAAA records that resolve to Athena's current public
address.

Caddy owns DDNS through the pinned `caddy-dynamicdns` app and the Cloudflare
`caddy-dns` provider module. The custom Caddy image is built with `xcaddy` and
must pin the Caddy base version and both module revisions. The generated Caddy
JSON configures only the explicit zones and record names that public ingress
manages; it must not discover or mutate unrelated records.

The Cloudflare provider module has two distinct roles in this image:

- `caddy-dynamicdns` uses it to update the configured A/AAAA records when
  Athena's public address changes;
- Caddy's ACME DNS-01 integration uses it for temporary challenge records when
  DNS-01 is required.

Neither role is implemented through a separate Cloudflare API sync model. The
Cloudflare API token is supplied to the Caddy container through a vault-backed
environment variable and never embedded in generated JSON. HTTP-01 or
TLS-ALPN remains preferable when those challenges are sufficient.

The custom image is managed declaratively with Quadlet: a `.build` unit builds
the pinned `xcaddy` image, and the Caddy `.container` depends on that build.
If the image is later published, a pinned `.image` pull unit may replace the
local build without changing the container contract.

## Request paths

Phase 1 public applications have one public front door:

```text
Cloudflare authoritative DNS A/AAAA record
  -> public IP of Athena
  -> nc.holi0317.net:443
  -> Caddy public listener
  -> application frontend
```

Phase 2 adds a separate private front door:

```text
Tailnet
  -> nextcloud.<tailnet-name>.ts.net:443
  -> Tailscale Service svc:nextcloud
  -> Caddy tailnet listener or application endpoint
  -> application frontend
```

The public and private hostnames are normally different. This avoids split-DNS
complexity and makes the trust boundary visible to users and operators. The
public route must work without any Tailscale Service advertisement.

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
- a systemd `ExecReload` that invokes `podman exec` to reload Caddy;

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
Exec=caddy run --config /etc/caddy/caddy.json

[Service]
ExecReload=/usr/bin/podman exec caddy caddy reload --config /etc/caddy/caddy.json
```

`ExecReload` causes systemd to run `podman exec` inside the existing
container. The operational command is therefore:

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
For the managed Caddy deployment, every tailnet site is routed through one
container listener on port `18080`, published only as
`127.0.0.1:18080` on Athena. Tailscale Serve endpoints therefore target
`http://127.0.0.1:18080` and Caddy selects the backend using the incoming
Service hostname. Public listeners remain on ports 80 and 443.
Tailscale's declarative `set-config` format does not preserve the distinction
between an HTTPS listener and an HTTP backend on the Tailscale version used by
Athena: importing `tcp:443` with an `http://` target creates a plaintext HTTP
endpoint on port 443. The managed Service unit therefore uses the explicit
`tailscale serve --https=443 127.0.0.1:18080` command instead of `set-config`.
See [Tailscale issue #18381](https://github.com/tailscale/tailscale/issues/18381).
If the Service definition also includes `tcp:80`, the same unit may configure
`--http=80 127.0.0.1:18081`. Caddy listens on that second loopback-only port
and returns a 308 redirect to the HTTPS Service URL; the HTTPS endpoint keeps
using `127.0.0.1:18080` for Grafana. This requires the Service port and grant
to be applied before the Serve unit is converged.

Both listeners handle bare service names too. Caddy matches requests whose
Host is the first DNS label of a tailnet site (for example `grafana`) and
answers with a 308 redirect to `https://<site>.tail351aa.ts.net` plus the
original path and query. This makes `http://grafana` on port 80 a single-hop
redirect to the full Service FQDN. MagicDNS resolves bare service names to the
node address, so the HTTP path is reachable. The HTTPS path is not: Tailscale
provisioned certificates only cover `*.tail351aa.ts.net` names, so tailscaled
aborts the TLS handshake with an internal-error alert for SNI `grafana` before
any HTTP traffic reaches Caddy. The matching bare-name route on port 18080
exists for completeness and any future ingress that delivers such requests;
`https://grafana` cannot be redirected under the current Tailscale Serve
behavior. Requests already addressed to the full FQDN keep the generic
`https://{host}{uri}` redirect on port 18081 and direct proxying on port
18080.

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

Cloudflare DNS/DDNS model
  owns explicit dynamic A/AAAA updates and record verification

Caddy image definition
  owns the pinned Caddy binary and any pinned Cloudflare DNS module

Caddy configuration model
  owns ingress inventory rendering, validation, file deployment,
  graceful reload, applied digest, and rollback state

Tailscale Service-host model
  owns local Serve JSON, endpoint configuration, advertisement,
  drain, and status in the deferred private-access phase

Tailscale control-plane resource
  owns Service definition, TailVIP identity, tags, and grants

workflow-machine-ingress-public
  orders network, Caddy, Cloudflare DNS/DDNS, config, and public applications

workflow-machine-ingress-tailnet
  orders Tailscale prerequisites, Service-host endpoints, tailnet routes,
  and go links after the public phase
```

Remote model operations must use the repository's shared
`@holi0317/remote-ssh` adapter and ultimately the `@swamp/ssh` fleet model.
Custom models must not invoke local `ssh`, `scp`, `rsync`, or private SSH pools.

Each workflow, not the Caddy, Cloudflare, or Tailscale model, owns ordering
between resources. The public workflow must not depend on the tailnet
workflow.

## Security requirements

- Do not mount the rootful Podman API socket into Caddy.
- Do not expose Caddy's admin API publicly or on the ingress network.
- Publish only Caddy ports `80` and `443` to the public host interface.
- Keep application, database, cache, FPM, and DDNS control interfaces private.
- Expose public sites explicitly; no container auto-discovery.
- Trust Tailscale identity headers only on a loopback-only trusted path.
- Store ACME state and Caddy data under persistent storage with restricted
  permissions.
- Store Cloudflare API tokens, Tailscale control-plane credentials, and any
  other DNS credentials in vaults.
- Scope Cloudflare tokens to the required zone and DNS record operations.
- Treat public and tailnet hostnames as separate security policies.
- Pin and review the custom Caddy DNS provider module before deployment.
- Drain Tailscale Service hosts before endpoint replacement or removal.
- Validate generated configurations before changing the active file.
- Restore the prior known-good configuration after an unsuccessful reload.

## Non-goals

This design does not initially provide:

- high availability for public ingress on the single Athena host;
- automatic discovery of arbitrary Podman containers;
- Tailscale Service exposure as a prerequisite for public ingress;
- a public Tailscale Funnel endpoint;
- split DNS for public hostnames;
- a general-purpose URL-shortener database or UI;
- public access to Tailscale Services;
- a replacement for application authentication.

## Implementation order

### Phase 1: Public Caddy ingress and Cloudflare DNS

1. Confirm the Cloudflare zone, Athena's current public address, required A and
   AAAA records, least-privilege API token scope, and DDNS requirements.
2. Inspect the Caddy Dynamic DNS app and Cloudflare DNS provider module;
   pin their source revisions and the Caddy base version for an xcaddy build.
3. Define the ingress network, Caddy Quadlet, custom image build, and
   vault-backed Cloudflare token secret.
4. Implement Caddy configuration rendering and custom-image validation.
5. Configure Caddy Dynamic DNS for only the explicit public zones and records;
   do not add a standalone Cloudflare DDNS model.
6. Deploy Caddy with a minimal health endpoint and one test route, using the
   ACME staging endpoint while testing certificate automation.
7. Add the Nextcloud frontend and shared ingress network.
8. Add public Nextcloud routing, public ACME validation, and DNS verification.
9. Migrate additional public applications one at a time.

### Phase 2: Private Tailscale Services

10. Confirm Athena's Tailscale version, tag identity, HTTPS enablement,
    Service-host approval policy, and grants.
11. Define and advertise `svc:nextcloud` with a tailnet HTTPS endpoint.
12. Add tailnet-specific Caddy routing and verify both certificates and access
    policies.
13. Add the `svc:go` redirect service and centrally generated go-link map.
14. Migrate remaining tailnet-only exposure one application at a time.

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
- [Caddy Cloudflare DNS provider module](https://caddyserver.com/docs/modules/dns.providers.cloudflare)
- [Cloudflare DNS record API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/)
