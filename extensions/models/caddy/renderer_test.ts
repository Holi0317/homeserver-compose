import { InventorySchema, renderInventory } from "./renderer.ts";

Deno.test("empty inventory renders private admin and health endpoint", () => {
  const config = JSON.parse(renderInventory({ sites: [] }));
  if (config.admin.listen !== "localhost:2019") {
    throw new Error("admin API is not restricted to the container loopback");
  }
  const server = config.apps.http.servers.ingressHttp;
  if (JSON.stringify(server.listen) !== JSON.stringify([":80"])) {
    throw new Error("empty inventory should only listen on HTTP");
  }
  if (server.routes[0].match[0].path[0] !== "/healthz") {
    throw new Error("empty inventory is missing the health endpoint");
  }
});

Deno.test("renderer is byte-stable across inventory ordering", () => {
  const first = renderInventory({
    sites: [
      {
        name: "zeta",
        public: {
          host: "zeta.example.test",
          upstreams: [{ name: "zeta-web", port: 80 }],
        },
      },
      {
        name: "alpha",
        public: {
          host: "alpha.example.test",
          upstreams: [{ name: "alpha-web", port: 80 }],
        },
      },
    ],
  });
  const second = renderInventory({
    sites: [
      {
        name: "alpha",
        public: {
          host: "alpha.example.test",
          upstreams: [{ name: "alpha-web", port: 80 }],
        },
      },
      {
        name: "zeta",
        public: {
          host: "zeta.example.test",
          upstreams: [{ name: "zeta-web", port: 80 }],
        },
      },
    ],
  });
  if (first !== second) throw new Error("rendering is not byte-stable");
});

Deno.test("renderer emits explicit proxy policies", () => {
  const config = JSON.parse(renderInventory({
    sites: [{
      name: "nextcloud",
      public: {
        host: "nc.example.test",
        tls: "internal",
        upstreams: [
          {
            name: "nextcloud-web",
            port: 80,
          },
        ],
        forwardedHeaders: {
          "X-Forwarded-Proto": ["https"],
        },
        middleware: {
          headers: {
            response: {
              set: { "Referrer-Policy": ["no-referrer"] },
            },
          },
          encode: { encodings: ["gzip", "zstd"] },
        },
        healthChecks: {
          active: { uri: "/status.php", interval: "10s", timeout: "3s" },
          passive: { maxFails: 2, failDuration: "20s", unhealthyStatus: [500] },
        },
        loadBalancing: {
          policy: "least_conn",
          retries: 2,
          tryDuration: "5s",
          tryInterval: "250ms",
        },
      },
    }],
  }));
  const httpServer = config.apps.http.servers.ingressHttp;
  const httpsServer = config.apps.http.servers.ingressHttps;
  if (JSON.stringify(httpServer.listen) !== JSON.stringify([":80"])) {
    throw new Error("TLS site did not retain the HTTP listener");
  }
  if (JSON.stringify(httpsServer.listen) !== JSON.stringify([":443"])) {
    throw new Error("TLS site did not enable the HTTPS listener");
  }
  const handlers = httpsServer.routes[0].handle;
  if (handlers[0].handler !== "headers" || handlers[1].handler !== "encode") {
    throw new Error("middleware handlers were not rendered in order");
  }
  const proxy = handlers[2];
  if (proxy.handler !== "reverse_proxy") {
    throw new Error("reverse proxy handler is missing");
  }
  if (proxy.upstreams[0].dial !== "nextcloud-web:80") {
    throw new Error("upstream name and port were not rendered");
  }
  if (proxy.load_balancing.selection_policy.policy !== "least_conn") {
    throw new Error("load-balancing policy was not rendered");
  }
  if (proxy.lb_retries !== 2 || proxy.lb_try_duration !== "5s") {
    throw new Error("retry policy was not rendered");
  }
  if (config.apps.tls.automation.policies[0].issuers[0].module !== "internal") {
    throw new Error("internal TLS policy was not rendered");
  }
});

Deno.test("public and tailnet exposure have separate listeners", () => {
  const disabled = JSON.parse(renderInventory({
    sites: [{
      name: "private",
      enabled: false,
      public: {
        host: "private.example.test",
        upstreams: [{ name: "private-web", port: 80 }],
      },
      tailnet: {
        host: "private.tail351aa.ts.net",
        upstreams: [{ name: "private-web", port: 80 }],
      },
    }],
  }));
  if (
    disabled.apps.http.servers.ingressHttp.routes[0].match[0].path[0] !==
      "/healthz"
  ) {
    throw new Error("disabled public site was exposed");
  }
  if (disabled.apps.http.servers.ingressTailnet !== undefined) {
    throw new Error("disabled tailnet site was exposed");
  }

  const config = JSON.parse(renderInventory({
    sites: [{
      name: "nextcloud",
      public: {
        host: "nextcloud.example.test",
        upstreams: [{ name: "nextcloud-web", port: 80 }],
      },
      tailnet: {
        host: "nextcloud.tail351aa.ts.net",
        upstreams: [{ name: "nextcloud-web", port: 80 }],
      },
    }],
  }));
  const servers = config.apps.http.servers;
  if (JSON.stringify(servers.ingressTailnet.listen) !== '[":18080"]') {
    throw new Error("tailnet listener is not the shared internal port");
  }
  if (servers.ingressTailnet.automatic_https.disable !== true) {
    throw new Error("tailnet listener enabled automatic HTTPS");
  }
  if (JSON.stringify(servers.ingressTailnetHttp.listen) !== '[":18081"]') {
    throw new Error("tailnet HTTP listener is not the redirect port");
  }
  const redirect = servers.ingressTailnetHttp.routes[0];
  if (redirect.handle[0].status_code !== "308") {
    throw new Error("tailnet HTTP listener did not redirect");
  }
  if (
    redirect.handle[0].headers.Location[0] !==
      "https://{http.request.host}{http.request.uri}"
  ) {
    throw new Error("tailnet redirect target is not HTTPS");
  }
  const tailnetRoute = servers.ingressTailnet.routes[0];
  if (tailnetRoute.match[0].host[0] !== "nextcloud.tail351aa.ts.net") {
    throw new Error("tailnet route does not match the Service hostname");
  }
  if (tailnetRoute.handle[0].upstreams[0].dial !== "nextcloud-web:80") {
    throw new Error("tailnet route upstream was not rendered");
  }
  if (
    servers.ingressHttps.routes[0].match[0].host[0] !== "nextcloud.example.test"
  ) {
    throw new Error("public route changed while adding tailnet routing");
  }
  const bareRedirect = servers.ingressTailnet.routes[1];
  if (bareRedirect.match[0].host[0] !== "nextcloud") {
    throw new Error("tailnet listener has no bare-name redirect route");
  }
  if (bareRedirect.handle[0].status_code !== "308") {
    throw new Error("bare-name HTTPS route did not redirect");
  }
  if (
    bareRedirect.handle[0].headers.Location[0] !==
      "https://nextcloud.tail351aa.ts.net{http.request.uri}"
  ) {
    throw new Error("bare-name HTTPS redirect is not the full Service FQDN");
  }
  const bareHttpRedirect = servers.ingressTailnetHttp.routes[1];
  if (bareHttpRedirect.match[0].host[0] !== "nextcloud") {
    throw new Error("tailnet HTTP listener has no bare-name redirect route");
  }
  if (
    bareHttpRedirect.handle[0].headers.Location[0] !==
      "https://nextcloud.tail351aa.ts.net{http.request.uri}"
  ) {
    throw new Error("bare-name HTTP redirect is not the full Service FQDN");
  }

  const duplicateHosts = InventorySchema.safeParse({
    sites: [
      {
        name: "one",
        tailnet: {
          host: "Example.tail351aa.ts.net",
          upstreams: [{ name: "one-web", port: 80 }],
        },
      },
      {
        name: "two",
        tailnet: {
          host: "example.tail351aa.ts.net",
          upstreams: [{ name: "two-web", port: 80 }],
        },
      },
    ],
  });
  if (duplicateHosts.success) {
    throw new Error("duplicate tailnet hosts were accepted");
  }
});

Deno.test("tailnet hosts must be Tailscale Service FQDNs", () => {
  const rejected = (host: string) =>
    !InventorySchema.safeParse({
      sites: [{
        name: "grafana",
        tailnet: {
          host,
          upstreams: [{ name: "grafana", port: 3000 }],
        },
      }],
    }).success;
  if (!rejected("grafana.tail351aa.example.com")) {
    throw new Error("a non-ts.net host was accepted");
  }
  if (!rejected("grafana.ts.net")) {
    throw new Error("a three-label ts.net host was accepted");
  }
  if (!rejected("ts.net")) {
    throw new Error("the registry suffix itself was accepted");
  }
  if (!rejected("grafana.west.tail351aa.ts.net")) {
    throw new Error(
      "a five-label ts.net host was accepted despite failing Tailscale cert issuance",
    );
  }
  if (
    !InventorySchema.safeParse({
      sites: [{
        name: "grafana",
        tailnet: {
          host: "grafana.tail351aa.ts.net",
          upstreams: [{ name: "grafana", port: 3000 }],
        },
      }],
    }).success
  ) {
    throw new Error("a valid Service FQDN was rejected");
  }
});

Deno.test("TLS off stays HTTP-only while TLS sites redirect", () => {
  const config = JSON.parse(renderInventory({
    sites: [
      {
        name: "automatic",
        public: {
          host: "automatic.example.test",
          upstreams: [{ name: "automatic-web", port: 80 }],
        },
      },
      {
        name: "plain",
        public: {
          host: "plain.example.test",
          tls: "off",
          upstreams: [{ name: "plain-web", port: 80 }],
        },
      },
    ],
  }));
  const servers = config.apps.http.servers;
  if (servers.ingressHttps.routes.length !== 1) {
    throw new Error("TLS-off site was exposed on the HTTPS listener");
  }
  type HostRoute = {
    match: [{ host: [string] }];
    handle: Array<Record<string, unknown>>;
  };
  const httpRoutes = servers.ingressHttp.routes as HostRoute[];
  const automaticHttp = httpRoutes.find((route) =>
    route.match[0].host[0] === "automatic.example.test"
  );
  const plainHttp = httpRoutes.find((route) =>
    route.match[0].host[0] === "plain.example.test"
  );
  if (automaticHttp === undefined || plainHttp === undefined) {
    throw new Error("expected both public HTTP routes");
  }
  if (automaticHttp.handle[0].status_code !== "308") {
    throw new Error("TLS site did not receive an explicit HTTPS redirect");
  }
  if (plainHttp.handle[0].handler !== "reverse_proxy") {
    throw new Error("TLS-off site was not rendered as an HTTP proxy");
  }
});

Deno.test("upstream TLS policies reject inconsistent settings", () => {
  const invalid = InventorySchema.safeParse({
    sites: [{
      name: "mixed",
      public: {
        host: "mixed.example.test",
        upstreams: [
          { name: "one", port: 443, tls: { insecureSkipVerify: false } },
          { name: "two", port: 443, tls: { insecureSkipVerify: true } },
        ],
      },
    }],
  });
  if (invalid.success) {
    throw new Error("mixed upstream TLS policy was accepted");
  }

  const unsupported = InventorySchema.safeParse({
    sites: [{
      name: "weighted",
      public: {
        host: "weighted.example.test",
        upstreams: [{ name: "weighted-web", port: 80 }],
        loadBalancing: { policy: "weighted" },
      },
    }],
  });
  if (unsupported.success) {
    throw new Error("unsupported weighted policy was accepted");
  }
});

Deno.test("Dynamic DNS uses explicit zones and vault environment placeholder", () => {
  const config = JSON.parse(renderInventory({ sites: [] }, {
    tokenEnv: "CLOUDFLARE_API_TOKEN",
    domains: { "holi0317.net": ["nc"] },
    checkInterval: "5m",
    ttl: "5m",
    versions: { ipv4: true, ipv6: true },
  }));
  const dynamicDns = config.apps.dynamic_dns;
  if (dynamicDns.providers[0].dns_provider.name !== "cloudflare") {
    throw new Error("Cloudflare DNS provider was not configured");
  }
  if (
    dynamicDns.providers[0].dns_provider.api_token !==
      "{env.CLOUDFLARE_API_TOKEN}"
  ) {
    throw new Error(
      "Cloudflare token was embedded instead of referenced by env",
    );
  }
  if (dynamicDns.providers[0].domains["holi0317.net"][0] !== "nc") {
    throw new Error("explicit DDNS domain was not rendered");
  }
});
Deno.test("Dynamic DNS auto TTL emits Cloudflare automatic sentinel", () => {
  const config = JSON.parse(renderInventory({ sites: [] }, {
    tokenEnv: "CLOUDFLARE_API_TOKEN",
    domains: { "holi0317.net": ["smoke"] },
    checkInterval: "5m",
    ttl: "auto",
    versions: { ipv4: true, ipv6: true },
  }));
  if (config.apps.dynamic_dns.ttl !== "1s") {
    throw new Error("Cloudflare automatic TTL was not rendered as 1s");
  }
});
Deno.test("path-specific routes render as ordered subroutes with h2c", () => {
  const config = JSON.parse(renderInventory({
    sites: [{
      name: "zitadel",
      public: {
        host: "auth.example.test",
        routes: [
          {
            path: "/",
            upstreams: [{ name: "zitadel-api", port: 8080, protocol: "h2c" }],
          },
          {
            path: "/ui/v2/login",
            upstreams: [{ name: "zitadel-login", port: 3000 }],
          },
        ],
      },
    }],
  }));
  const site = config.apps.http.servers.ingressHttps.routes[0];
  const subroute = site.handle[0];
  if (subroute.handler !== "subroute" || subroute.routes.length !== 2) {
    throw new Error("path-specific routes were not rendered as a subroute");
  }
  if (subroute.routes[0].match[0].path[0] !== "/ui/v2/login*") {
    throw new Error("specific Zitadel login route was not ordered first");
  }
  const apiProxy = subroute.routes[1].handle[0];
  if (apiProxy.transport?.versions?.[0] !== "h2c") {
    throw new Error("Zitadel API route did not enable h2c upstream transport");
  }
});
