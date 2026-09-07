import type * as z from "zod";
import type { Inventory, PublicSite, TailnetSite } from "./schema.ts";
import {
  type HealthChecksSchema,
  InventorySchema,
  type MiddlewareSchema,
  type UpstreamsSchema,
} from "./schema.ts";

type HeaderMap = Record<string, string[]>;
type HeaderOperation = {
  set?: HeaderMap;
  add?: HeaderMap;
  delete?: string[];
};

type CaddyHandler = Record<string, unknown>;

export type DynamicDnsConfig = {
  tokenEnv: string;
  domains: Record<string, string[]>;
  checkInterval: string;
  ttl: string;
  versions: { ipv4: boolean; ipv6: boolean };
};

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

function renderProxy(
  upstreams: z.infer<typeof UpstreamsSchema>,
  exposure: PublicSite | TailnetSite,
): CaddyHandler {
  const firstUpstream = upstreams[0];
  const reverseProxy: CaddyHandler = {
    handler: "reverse_proxy",
    upstreams: [...upstreams]
      .sort((left, right) =>
        `${left.name}:${left.port}`.localeCompare(`${right.name}:${right.port}`)
      )
      .map((upstream) => ({ dial: `${upstream.name}:${upstream.port}` })),
  };

  if (firstUpstream.protocol === "h2c") {
    reverseProxy.transport = { protocol: "http", versions: ["h2c"] };
  } else if (firstUpstream.tls !== undefined) {
    reverseProxy.transport = {
      protocol: "http",
      tls: { insecure_skip_verify: firstUpstream.tls.insecureSkipVerify },
    };
  }
  if (exposure.forwardedHeaders !== undefined) {
    reverseProxy.headers = {
      request: { set: sortedHeaderMap(exposure.forwardedHeaders) },
    };
  }
  if (exposure.healthChecks !== undefined) {
    reverseProxy.health_checks = renderHealthChecks(exposure.healthChecks);
  }
  if (exposure.loadBalancing !== undefined) {
    reverseProxy.load_balancing = {
      selection_policy: { policy: exposure.loadBalancing.policy },
    };
    if (exposure.loadBalancing.retries !== undefined) {
      reverseProxy.lb_retries = exposure.loadBalancing.retries;
    }
    if (exposure.loadBalancing.tryDuration !== undefined) {
      reverseProxy.lb_try_duration = exposure.loadBalancing.tryDuration;
    }
    if (exposure.loadBalancing.tryInterval !== undefined) {
      reverseProxy.lb_try_interval = exposure.loadBalancing.tryInterval;
    }
  }
  return reverseProxy;
}

function sortedRoutes(
  exposure: PublicSite | TailnetSite,
): { path: string; upstreams: z.infer<typeof UpstreamsSchema> }[] {
  return exposure.routes !== undefined
    ? [...exposure.routes].sort((left, right) =>
      right.path.length - left.path.length ||
      left.path.localeCompare(right.path)
    )
    : [{ path: "/", upstreams: exposure.upstreams! }];
}

function renderExposure(
  host: string,
  exposure: PublicSite | TailnetSite,
): CaddyHandler {
  const routes = sortedRoutes(exposure);
  const middleware = renderMiddleware(exposure.middleware ?? {});
  if (exposure.routes === undefined) {
    return {
      match: [{ host: [host] }],
      handle: [
        ...middleware,
        renderProxy(exposure.upstreams!, exposure),
      ],
      terminal: true,
    };
  }
  return {
    match: [{ host: [host] }],
    handle: [{
      handler: "subroute",
      routes: routes.map((route) => ({
        match: [{ path: [route.path === "/" ? "/*" : `${route.path}*`] }],
        handle: [
          ...middleware,
          renderProxy(route.upstreams, exposure),
        ],
        terminal: true,
      })),
    }],
    terminal: true,
  };
}

function renderPublicSite(
  site: Inventory["sites"][number],
  listener: "http" | "https",
): CaddyHandler | null {
  if (!site.enabled || site.public === undefined) return null;

  const exposure = site.public;
  const tlsEnabled = exposure.tls !== "off";
  if (listener === "https" && !tlsEnabled) return null;
  if (listener === "http" && tlsEnabled) {
    return {
      match: [{ host: [exposure.host] }],
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

  return renderExposure(exposure.host, exposure);
}

function renderTailnetSite(
  site: Inventory["sites"][number],
): CaddyHandler | null {
  if (!site.enabled || site.tailnet === undefined) return null;
  return renderExposure(site.tailnet.host, site.tailnet);
}

function renderTailnetRedirectSite(
  site: Inventory["sites"][number],
): CaddyHandler | null {
  if (!site.enabled || site.tailnet === undefined) return null;

  return {
    match: [{ host: [site.tailnet.host] }],
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

function renderTailnetBareNameRedirectSite(
  site: Inventory["sites"][number],
): CaddyHandler | null {
  if (!site.enabled || site.tailnet === undefined) return null;

  const host = site.tailnet.host;
  const bareName = host.split(".")[0];
  if (bareName === host) return null;

  return {
    match: [{ host: [bareName] }],
    handle: [{
      handler: "static_response",
      status_code: "308",
      headers: {
        Location: [`https://${host}{http.request.uri}`],
      },
    }],
    terminal: true,
  };
}

function renderDynamicDns(
  dynamicDns: NonNullable<DynamicDnsConfig>,
): Record<string, unknown> {
  const domains = Object.fromEntries(
    Object.entries(dynamicDns.domains)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([zone, names]) => [zone, [...names].sort()]),
  );
  return {
    dynamic_dns: {
      providers: [{
        dns_provider: {
          name: "cloudflare",
          api_token: `{env.${dynamicDns.tokenEnv}}`,
        },
        domains,
      }],
      check_interval: dynamicDns.checkInterval,
      ttl: dynamicDns.ttl === "auto" ? "1s" : dynamicDns.ttl,
      versions: dynamicDns.versions,
    },
  };
}

export function renderInventory(
  input: unknown,
  dynamicDns?: DynamicDnsConfig,
): string {
  const inventory = InventorySchema.parse(input);
  const orderedSites = [...inventory.sites].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const publicSites = orderedSites.filter(
    (site) => site.enabled && site.public !== undefined,
  );
  const httpRoutes = orderedSites
    .map((site) => renderPublicSite(site, "http"))
    .filter((route): route is CaddyHandler => route !== null);
  const httpsRoutes = publicSites
    .map((site) => renderPublicSite(site, "https"))
    .filter((route): route is CaddyHandler => route !== null);
  const tailnetRoutes = orderedSites
    .map(renderTailnetSite)
    .filter((route): route is CaddyHandler => route !== null);
  const tailnetBareNameRoutes = orderedSites
    .map(renderTailnetBareNameRedirectSite)
    .filter((route): route is CaddyHandler => route !== null);
  const tailnetHttpRoutes = orderedSites
    .map(renderTailnetRedirectSite)
    .filter((route): route is CaddyHandler => route !== null);
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
  if (tailnetRoutes.length > 0) {
    servers.ingressTailnet = {
      listen: [":18080"],
      automatic_https: { disable: true },
      routes: [...tailnetRoutes, ...tailnetBareNameRoutes],
    };
  }
  if (tailnetHttpRoutes.length > 0) {
    servers.ingressTailnetHttp = {
      listen: [":18081"],
      automatic_https: { disable: true },
      routes: [...tailnetHttpRoutes, ...tailnetBareNameRoutes],
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
  if (dynamicDns !== undefined) {
    config.apps = {
      ...(config.apps as Record<string, unknown>),
      ...renderDynamicDns(dynamicDns),
    };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}
