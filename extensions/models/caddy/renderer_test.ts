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

Deno.test("public exposure is opt-in and tailnet fields are rejected", () => {
  const disabled = JSON.parse(renderInventory({
    sites: [{
      name: "private",
      enabled: false,
      public: {
        host: "private.example.test",
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

  const invalid = InventorySchema.safeParse({
    sites: [{
      name: "nextcloud",
      tailnet: { host: "nextcloud.example.ts.net" },
    }],
  });
  if (invalid.success) throw new Error("tailnet fields were accepted");
  const duplicateHosts = InventorySchema.safeParse({
    sites: [
      {
        name: "one",
        public: {
          host: "Example.test",
          upstreams: [{ name: "one-web", port: 80 }],
        },
      },
      {
        name: "two",
        public: {
          host: "example.test",
          upstreams: [{ name: "two-web", port: 80 }],
        },
      },
    ],
  });
  if (duplicateHosts.success) {
    throw new Error("duplicate public hosts were accepted");
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
