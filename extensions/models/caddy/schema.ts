import * as z from "zod";

export const Identifier = z.string().min(1).max(63).regex(
  /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  "must start with a letter or number and contain only letters, numbers, '.', '_', or '-'",
);

const Hostname = z.string().min(1).max(253).regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/,
  "must be an ASCII DNS hostname without a scheme, port, or path",
);

export const TsNetServiceHostname = Hostname.refine(
  (host) => {
    const labels = host.split(".").map((label) => label.toLowerCase());
    return labels.length === 4 &&
      labels[2] === "ts" &&
      labels[3] === "net";
  },
  "must be a <service>.<tailnet>.ts.net Tailscale Service FQDN; deeper names fail Tailscale HTTPS certificate issuance",
);

export const Duration = z.string().regex(
  /^\d+(?:ms|s|m|h)(?:\d+(?:ms|s|m|h))*$/,
  "must be a Caddy duration such as 5s or 1m30s",
);

export const HeaderValues = z.record(
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
);

const HeaderOperations = z.strictObject({
  set: HeaderValues.optional(),
  add: HeaderValues.optional(),
  delete: z.array(z.string().min(1)).min(1).optional(),
}).refine(
  (value) =>
    value.set !== undefined || value.add !== undefined ||
    value.delete !== undefined,
  "must define at least one header operation",
);

const HeadersMiddleware = z.strictObject({
  request: HeaderOperations.optional(),
  response: HeaderOperations.optional(),
}).refine(
  (value) => value.request !== undefined || value.response !== undefined,
  "must define request or response header operations",
);

const EncodeMiddleware = z.strictObject({
  encodings: z.array(z.enum(["gzip", "zstd", "identity"])).min(1),
});

export const MiddlewareSchema = z.strictObject({
  headers: HeadersMiddleware.optional(),
  encode: EncodeMiddleware.optional(),
}).refine(
  (value) => value.headers !== undefined || value.encode !== undefined,
  "must define at least one middleware handler",
);

export const UpstreamSchema = z.strictObject({
  name: Identifier,
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["http", "h2c"]).default("http"),
  tls: z.strictObject({
    insecureSkipVerify: z.boolean().default(false),
  }).optional(),
}).superRefine((upstream, context) => {
  if (upstream.protocol === "h2c" && upstream.tls !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["tls"],
      message: "h2c upstreams cannot configure TLS",
    });
  }
});

export const UpstreamsSchema = z.array(UpstreamSchema).min(1).superRefine(
  (upstreams, context) => {
    const first = upstreams[0];
    const firstTransport = `${first.protocol}:${
      first.tls?.insecureSkipVerify ?? "plain"
    }`;
    const names = new Set<string>();
    for (let index = 0; index < upstreams.length; index++) {
      const upstream = upstreams[index];
      const key = `${upstream.name}:${upstream.port}`;
      if (names.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate upstream ${key}`,
        });
      }
      names.add(key);
      const transport = `${upstream.protocol}:${
        upstream.tls?.insecureSkipVerify ?? "plain"
      }`;
      if (transport !== firstTransport) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "all upstreams must use the same transport policy",
        });
      }
    }
  },
);

const ActiveHealthSchema = z.strictObject({
  uri: z.string().min(1),
  interval: Duration.default("30s"),
  timeout: Duration.default("5s"),
  headers: HeaderValues.optional(),
});

const PassiveHealthSchema = z.strictObject({
  maxFails: z.number().int().positive().default(3),
  failDuration: Duration.default("30s"),
  unhealthyStatus: z.array(z.number().int().min(100).max(599)).default([]),
});

export const HealthChecksSchema = z.strictObject({
  active: ActiveHealthSchema.optional(),
  passive: PassiveHealthSchema.optional(),
}).refine(
  (value) => value.active !== undefined || value.passive !== undefined,
  "must define active or passive health checks",
);

const LoadBalancingSchema = z.strictObject({
  policy: z.enum([
    "first",
    "ip_hash",
    "least_conn",
    "random",
    "uri_hash",
  ]),
  retries: z.number().int().nonnegative().optional(),
  tryDuration: Duration.optional(),
  tryInterval: Duration.optional(),
});

const RouteSchema = z.strictObject({
  path: z.string().min(1).max(2048).regex(
    /^\/(?:[^\s?*]*)$/,
    "must be an absolute path without whitespace, query, or wildcard characters",
  ),
  upstreams: UpstreamsSchema,
});

const SiteExposureSchema = {
  upstreams: UpstreamsSchema.optional(),
  routes: z.array(RouteSchema).min(1).optional(),
  middleware: MiddlewareSchema.optional(),
  forwardedHeaders: HeaderValues.optional(),
  healthChecks: HealthChecksSchema.optional(),
  loadBalancing: LoadBalancingSchema.optional(),
};

function refineExposure<
  T extends { upstreams?: unknown; routes?: { path: string }[] },
>(schema: z.ZodType<T>): z.ZodType<T> {
  return schema.superRefine((site, context) => {
    if (site.upstreams === undefined && site.routes === undefined) {
      context.addIssue({
        code: "custom",
        path: ["upstreams"],
        message: "configure upstreams or path-specific routes",
      });
    }
    if (site.upstreams !== undefined && site.routes !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "configure either upstreams or path-specific routes, not both",
      });
    }
    const routePaths = new Set<string>();
    for (const route of site.routes ?? []) {
      if (routePaths.has(route.path)) {
        context.addIssue({
          code: "custom",
          path: ["routes"],
          message: `duplicate route path ${route.path}`,
        });
      }
      routePaths.add(route.path);
    }
  });
}

export const PublicSiteSchema = refineExposure(
  z.strictObject({
    host: Hostname,
    tls: z.enum(["automatic", "internal", "off"]).default("automatic"),
    ...SiteExposureSchema,
  }),
);

export const TailnetSiteSchema = refineExposure(
  z.strictObject({
    host: TsNetServiceHostname,
    ...SiteExposureSchema,
  }),
);

export const SiteSchema = z.strictObject({
  name: Identifier,
  enabled: z.boolean().default(true),
  public: PublicSiteSchema.optional(),
  tailnet: TailnetSiteSchema.optional(),
});

export const InventorySchema = z.strictObject({
  sites: z.array(SiteSchema).default([]),
}).superRefine((inventory, context) => {
  const names = new Set<string>();
  const publicHosts = new Set<string>();
  const tailnetHosts = new Set<string>();
  for (const site of inventory.sites) {
    if (names.has(site.name)) {
      context.addIssue({
        code: "custom",
        path: ["sites"],
        message: `duplicate site ${site.name}`,
      });
    }
    names.add(site.name);
    if (site.enabled && site.public !== undefined) {
      const host = site.public.host.toLowerCase();
      if (publicHosts.has(host)) {
        context.addIssue({
          code: "custom",
          path: ["sites"],
          message: `duplicate public host ${site.public.host}`,
        });
      }
      publicHosts.add(host);
    }
    if (site.enabled && site.tailnet !== undefined) {
      const host = site.tailnet.host.toLowerCase();
      if (tailnetHosts.has(host)) {
        context.addIssue({
          code: "custom",
          path: ["sites"],
          message: `duplicate tailnet host ${site.tailnet.host}`,
        });
      }
      tailnetHosts.add(host);
    }
  }
});

export type Inventory = z.infer<typeof InventorySchema>;
export type PublicSite = z.infer<typeof PublicSiteSchema>;
export type TailnetSite = z.infer<typeof TailnetSiteSchema>;

export const RenderedConfigSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  json: z.string().min(1),
  siteNames: z.array(Identifier),
});

export const DeploymentSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  remoteDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidatePath: z.string().min(1),
  activePath: z.string().min(1),
  serviceName: Identifier,
  backupPath: z.string().optional(),
  rolledBack: z.boolean(),
  appliedAt: z.iso.datetime(),
});

export const DynamicDnsSchema = z.strictObject({
  tokenEnv: z.literal("CLOUDFLARE_API_TOKEN").default("CLOUDFLARE_API_TOKEN"),
  domains: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
  checkInterval: Duration.default("5m"),
  ttl: z.union([Duration, z.literal("auto")]).default("auto"),
  versions: z.strictObject({
    ipv4: z.boolean().default(true),
    ipv6: z.boolean().default(true),
  }).default({ ipv4: true, ipv6: true }),
}).refine(
  (value) => Object.keys(value.domains).length > 0,
  "must configure at least one DNS zone",
);

const GlobalArgumentsSchema = z.strictObject({
  inventory: InventorySchema.default({ sites: [] }),
  dynamicDns: DynamicDnsSchema.optional(),
});

export const RemoteSchema = z.strictObject({
  fleet: z.string().min(1),
  host: z.string().min(1),
  sudo: z.boolean().default(true),
});

export const ConfigGlobalArgumentsSchema = GlobalArgumentsSchema.extend({
  remote: RemoteSchema.optional(),
  configDirectory: z.string().min(1).refine(
    (value) => value.startsWith("/") && !value.includes(".."),
    "must be an absolute path without traversal",
  ).default("/srv/persistent/caddy/config"),
  caddyImage: z.string().min(1).regex(/\S+/, "must not contain whitespace")
    .default("localhost/caddy-cloudflare-ddns:2.11.4"),
  serviceName: Identifier.default("caddy.service"),
  timeoutSeconds: z.number().int().positive().default(300),
});

export const ValidateArgumentsSchema = ConfigGlobalArgumentsSchema.extend({
  configName: z.string().min(1).default("current"),
});

export const ApplyArgumentsSchema = ValidateArgumentsSchema;
