import { z } from "npm:zod@4";

const Identifier = z.string().min(1).max(63).regex(
  /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  "must start with a letter or number and contain only letters, numbers, '.', '_', or '-'",
);

const Hostname = z.string().min(1).max(253).regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/,
  "must be an ASCII DNS hostname without a scheme, port, or path",
);

const Duration = z.string().regex(
  /^\d+(?:ms|s|m|h)(?:\d+(?:ms|s|m|h))*$/,
  "must be a Caddy duration such as 5s or 1m30s",
);

const HeaderValues = z.record(
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
  tls: z.strictObject({
    insecureSkipVerify: z.boolean().default(false),
  }).optional(),
});

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

const PublicSiteSchema = z.strictObject({
  host: Hostname,
  tls: z.enum(["automatic", "internal", "off"]).default("automatic"),
  upstreams: z.array(UpstreamSchema).min(1),
  middleware: MiddlewareSchema.optional(),
  forwardedHeaders: HeaderValues.optional(),
  healthChecks: HealthChecksSchema.optional(),
  loadBalancing: LoadBalancingSchema.optional(),
}).superRefine((site, context) => {
  const secure = site.upstreams.filter((upstream) => upstream.tls !== undefined)
    .length;
  if (secure !== 0 && secure !== site.upstreams.length) {
    context.addIssue({
      code: "custom",
      path: ["upstreams"],
      message: "all upstreams must use the same HTTP or HTTPS transport",
    });
  }
  if (secure === site.upstreams.length && secure > 0) {
    const verificationPolicies = new Set(
      site.upstreams.map((upstream) => upstream.tls!.insecureSkipVerify),
    );
    if (verificationPolicies.size !== 1) {
      context.addIssue({
        code: "custom",
        path: ["upstreams"],
        message:
          "all HTTPS upstreams must use the same TLS verification policy",
      });
    }
  }

  const names = new Set<string>();
  for (const upstream of site.upstreams) {
    const key = `${upstream.name}:${upstream.port}`;
    if (names.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["upstreams"],
        message: `duplicate upstream ${key}`,
      });
    }
    names.add(key);
  }
});

export const SiteSchema = z.strictObject({
  name: Identifier,
  enabled: z.boolean().default(true),
  public: PublicSiteSchema.optional(),
});

export const InventorySchema = z.strictObject({
  sites: z.array(SiteSchema).default([]),
}).superRefine((inventory, context) => {
  const names = new Set<string>();
  const hosts = new Set<string>();
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
      if (hosts.has(host)) {
        context.addIssue({
          code: "custom",
          path: ["sites"],
          message: `duplicate public host ${site.public.host}`,
        });
      }
      hosts.add(host);
    }
  }
});
export type Inventory = z.infer<typeof InventorySchema>;

type HeaderMap = Record<string, string[]>;
type HeaderOperation = {
  set?: HeaderMap;
  add?: HeaderMap;
  delete?: string[];
};

type CaddyHandler = Record<string, unknown>;

function sortedHeaderMap(values: HeaderMap): HeaderMap {
  return Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, [...value]]),
  );
}

function renderHeaderOperations(operations: HeaderOperation) {
  const rendered: Record<string, unknown> = {};
  if (operations.set !== undefined) {
    rendered.set = sortedHeaderMap(operations.set);
  }
  if (operations.add !== undefined) {
    rendered.add = sortedHeaderMap(operations.add);
  }
  if (operations.delete !== undefined) {
    rendered.delete = [...operations.delete].sort();
  }
  return rendered;
}

function renderMiddleware(middleware: z.infer<typeof MiddlewareSchema>) {
  const handlers: CaddyHandler[] = [];
  if (middleware.headers !== undefined) {
    const headers: Record<string, unknown> = { handler: "headers" };
    if (middleware.headers.request !== undefined) {
      headers.request = renderHeaderOperations(middleware.headers.request);
    }
    if (middleware.headers.response !== undefined) {
      headers.response = renderHeaderOperations(middleware.headers.response);
    }
    handlers.push(headers);
  }
  if (middleware.encode !== undefined) {
    handlers.push({
      handler: "encode",
      encodings: Object.fromEntries(
        [...middleware.encode.encodings].sort().map((
          encoding,
        ) => [encoding, {}]),
      ),
    });
  }
  return handlers;
}

function renderHealthChecks(
  healthChecks: z.infer<typeof HealthChecksSchema>,
) {
  const rendered: Record<string, unknown> = {};
  if (healthChecks.active !== undefined) {
    const active: Record<string, unknown> = {
      uri: healthChecks.active.uri,
      interval: healthChecks.active.interval,
      timeout: healthChecks.active.timeout,
    };
    if (healthChecks.active.headers !== undefined) {
      active.headers = sortedHeaderMap(healthChecks.active.headers);
    }
    rendered.active = active;
  }
  if (healthChecks.passive !== undefined) {
    rendered.passive = {
      max_fails: healthChecks.passive.maxFails,
      fail_duration: healthChecks.passive.failDuration,
      unhealthy_status: [...healthChecks.passive.unhealthyStatus].sort(
        (left, right) => left - right,
      ),
    };
  }
  return rendered;
}

function renderSite(
  site: Inventory["sites"][number],
  listener: "http" | "https",
): CaddyHandler | null {
  if (!site.enabled || site.public === undefined) return null;

  const publicSite = site.public;
  const tlsEnabled = publicSite.tls !== "off";
  if (listener === "https" && !tlsEnabled) return null;
  if (listener === "http" && tlsEnabled) {
    return {
      match: [{ host: [publicSite.host] }],
      handle: [{
        handler: "static_response",
        status_code: "308",
        headers: {
          Location: ["https://{http.request.host}{http.request.uri}"],
        },
      }],
      terminal: true,
    };
  }

  const secureUpstreams = publicSite.upstreams[0].tls !== undefined;
  const reverseProxy: CaddyHandler = {
    handler: "reverse_proxy",
    upstreams: [...publicSite.upstreams]
      .sort((left, right) =>
        `${left.name}:${left.port}`.localeCompare(`${right.name}:${right.port}`)
      )
      .map((upstream) => ({ dial: `${upstream.name}:${upstream.port}` })),
  };

  if (secureUpstreams) {
    reverseProxy.transport = {
      protocol: "http",
      tls: {
        insecure_skip_verify: publicSite.upstreams[0].tls!.insecureSkipVerify,
      },
    };
  }
  if (publicSite.forwardedHeaders !== undefined) {
    reverseProxy.headers = {
      request: { set: sortedHeaderMap(publicSite.forwardedHeaders) },
    };
  }
  if (publicSite.healthChecks !== undefined) {
    reverseProxy.health_checks = renderHealthChecks(publicSite.healthChecks);
  }
  if (publicSite.loadBalancing !== undefined) {
    reverseProxy.load_balancing = {
      selection_policy: { policy: publicSite.loadBalancing.policy },
    };
    if (publicSite.loadBalancing.retries !== undefined) {
      reverseProxy.lb_retries = publicSite.loadBalancing.retries;
    }
    if (publicSite.loadBalancing.tryDuration !== undefined) {
      reverseProxy.lb_try_duration = publicSite.loadBalancing.tryDuration;
    }
    if (publicSite.loadBalancing.tryInterval !== undefined) {
      reverseProxy.lb_try_interval = publicSite.loadBalancing.tryInterval;
    }
  }

  return {
    match: [{ host: [publicSite.host] }],
    handle: [
      ...renderMiddleware(publicSite.middleware ?? {}),
      reverseProxy,
    ],
    terminal: true,
  };
}

export function renderInventory(input: unknown): string {
  const inventory = InventorySchema.parse(input);
  const orderedSites = [...inventory.sites].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const publicSites = orderedSites.filter(
    (site) => site.enabled && site.public !== undefined,
  );
  const httpRoutes = orderedSites
    .map((site) => renderSite(site, "http"))
    .filter((site): site is CaddyHandler => site !== null);
  const httpsRoutes = publicSites
    .map((site) => renderSite(site, "https"))
    .filter((site): site is CaddyHandler => site !== null);
  const healthRoute: CaddyHandler = {
    match: [{ path: ["/healthz"] }],
    handle: [{
      handler: "static_response",
      status_code: "200",
      body: "ok",
    }],
    terminal: true,
  };
  const servers: Record<string, unknown> = {
    ingressHttp: {
      listen: [":80"],
      routes: httpRoutes.length > 0 ? httpRoutes : [healthRoute],
    },
  };
  if (httpsRoutes.length > 0) {
    servers.ingressHttps = {
      listen: [":443"],
      routes: httpsRoutes,
    };
  }

  const config: Record<string, unknown> = {
    admin: { listen: "localhost:2019" },
    apps: {
      http: { servers },
    },
  };
  const internalSites = publicSites.filter(
    (site) => site.public!.tls === "internal",
  );
  if (internalSites.length > 0) {
    config.apps = {
      ...(config.apps as Record<string, unknown>),
      tls: {
        automation: {
          policies: internalSites.map((site) => ({
            subjects: [site.public!.host],
            issuers: [{ module: "internal" }],
          })),
        },
      },
    };
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

const RenderedConfigSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  json: z.string().min(1),
  siteNames: z.array(Identifier),
});

const GlobalArgumentsSchema = z.strictObject({
  inventory: InventorySchema.default({ sites: [] }),
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function validateWithCaddy(json: string): Promise<void> {
  const configPath = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(configPath, json);
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command("caddy", {
        args: ["validate", "--config", configPath, "--adapter", "json"],
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (error) {
      throw new Error(
        `Caddy validation requires the caddy executable: ${String(error)}`,
      );
    }
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      throw new Error(`Caddy rejected the generated configuration: ${stderr}`);
    }
  } finally {
    await Deno.remove(configPath).catch(() => undefined);
  }
}

const ValidateArgumentsSchema = GlobalArgumentsSchema.extend({
  configName: z.string().min(1),
});

export const model = {
  type: "@holi0317/caddy/config",
  version: "2026.08.18.1",
  globalArguments: GlobalArgumentsSchema,
  resources: {
    config: {
      description: "Deterministic Caddy JSON rendered from ingress inventory",
      schema: RenderedConfigSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    render: {
      description: "Render and record deterministic Caddy JSON",
      arguments: GlobalArgumentsSchema,
      execute: async (_args: z.infer<typeof GlobalArgumentsSchema>, context: {
        globalArgs: unknown;
        writeResource: (
          specName: string,
          instanceName: string,
          data: Record<string, unknown>,
        ) => Promise<{ name: string }>;
      }) => {
        const globalArguments = GlobalArgumentsSchema.parse(context.globalArgs);
        const json = renderInventory(globalArguments.inventory);
        const digest = await sha256(json);
        const siteNames = globalArguments.inventory.sites
          .filter((site) => site.enabled && site.public !== undefined)
          .map((site) => site.name)
          .sort();
        const handle = await context.writeResource("config", digest, {
          digest,
          json,
          siteNames,
        });
        return { dataHandles: [handle] };
      },
    },
    validate: {
      description: "Validate a rendered Caddy JSON artifact with Caddy",
      arguments: ValidateArgumentsSchema,
      execute: async (args: z.infer<typeof ValidateArgumentsSchema>, context: {
        globalArgs: unknown;
        readResource: (
          instanceName: string,
        ) => Promise<Record<string, unknown> | null>;
      }) => {
        const validatedArgs = ValidateArgumentsSchema.parse(args);
        const resource = await context.readResource(validatedArgs.configName);
        if (resource === null || typeof resource.json !== "string") {
          throw new Error(
            `Rendered Caddy configuration ${validatedArgs.configName} was not found`,
          );
        }
        await validateWithCaddy(resource.json);
        return { dataHandles: [] };
      },
    },
  },
};
