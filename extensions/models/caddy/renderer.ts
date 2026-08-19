import { z } from "npm:zod@4";
import {
  ensureDir,
  runRemoteExec,
  shlexQuote,
  uploadFile,
} from "@holi0317/remote-ssh";
import type { RemoteContext } from "@holi0317/remote-ssh";

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

type DynamicDnsConfig = {
  tokenEnv: string;
  domains: Record<string, string[]>;
  checkInterval: string;
  ttl: string;
  versions: { ipv4: boolean; ipv6: boolean };
};

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

  if (dynamicDns !== undefined) {
    const domains = Object.fromEntries(
      Object.entries(dynamicDns.domains)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([zone, names]) => [zone, [...names].sort()]),
    );
    const apps = config.apps as Record<string, unknown>;
    apps.dynamic_dns = {
      providers: [{
        dns_provider: {
          name: "cloudflare",
          api_token: `{env.${dynamicDns.tokenEnv}}`,
        },
        domains,
      }],
      check_interval: dynamicDns.checkInterval,
      ttl: dynamicDns.ttl,
      versions: dynamicDns.versions,
    };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}
const RenderedConfigSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  json: z.string().min(1),
  siteNames: z.array(Identifier),
});

const DynamicDnsSchema = z.strictObject({
  tokenEnv: z.literal("CLOUDFLARE_API_TOKEN").default("CLOUDFLARE_API_TOKEN"),
  domains: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
  checkInterval: Duration.default("5m"),
  ttl: Duration.default("5m"),
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

const RemoteSchema = z.strictObject({
  fleet: z.string().min(1),
  host: z.string().min(1),
  sudo: z.boolean().default(true),
});

const ConfigGlobalArgumentsSchema = GlobalArgumentsSchema.extend({
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

async function ensureLocalCaddyImage(
  image: string,
  context: CaddyMethodContext,
): Promise<void> {
  const existing = await new Deno.Command("podman", {
    args: ["image", "exists", image],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (existing.success) return;
  const containerfile = context.extensionFile("Containerfile");
  const contextDirectory = containerfile.slice(
    0,
    containerfile.lastIndexOf("/"),
  );
  const build = await new Deno.Command("podman", {
    args: [
      "build",
      "--tag",
      image,
      "--file",
      containerfile,
      contextDirectory,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!build.success) {
    throw new Error(
      `Unable to build local Caddy image ${image}: ${
        new TextDecoder().decode(build.stderr).trim()
      }`,
    );
  }
}

async function validateWithCaddy(
  json: string,
  image: string,
  context: CaddyMethodContext,
): Promise<void> {
  await ensureLocalCaddyImage(image, context);
  const configPath = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(configPath, json);
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command("podman", {
        args: [
          "run",
          "--rm",
          "--volume",
          `${configPath}:/etc/caddy/caddy.json:ro`,
          "--env",
          "CLOUDFLARE_API_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",

          image,
          "caddy",
          "validate",
          "--config",
          "/etc/caddy/caddy.json",
          "--adapter",
          "json",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (error) {
      throw new Error(
        `Caddy image validation requires local podman and ${image}: ${
          String(error)
        }`,
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

const ValidateArgumentsSchema = ConfigGlobalArgumentsSchema.extend({
  configName: z.string().min(1).default("current"),
});

const ApplyArgumentsSchema = ValidateArgumentsSchema;

const DeploymentSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  remoteDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidatePath: z.string().min(1),
  activePath: z.string().min(1),
  serviceName: Identifier,
  backupPath: z.string().optional(),
  rolledBack: z.boolean(),
  appliedAt: z.iso.datetime(),
});

type CaddyMethodContext = RemoteContext & {
  globalArgs: unknown;
  extensionFile: (path: string) => string;
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

function remotePath(directory: string, filename: string): string {
  return `${directory.replace(/\/+$/, "")}/${filename}`;
}
export const model = {
  type: "@holi0317/caddy/config",
  version: "2026.08.18.3",
  globalArguments: ConfigGlobalArgumentsSchema,
  resources: {
    config: {
      description: "Deterministic Caddy JSON rendered from ingress inventory",
      schema: RenderedConfigSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    deployment: {
      description: "Active Caddy configuration deployment state",
      schema: DeploymentSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    render: {
      description: "Render and record deterministic Caddy JSON",
      arguments: ConfigGlobalArgumentsSchema,
      execute: async (
        _args: z.infer<typeof ConfigGlobalArgumentsSchema>,
        context: CaddyMethodContext,
      ) => {
        const globalArguments = ConfigGlobalArgumentsSchema.parse(
          context.globalArgs,
        );
        const json = renderInventory(
          globalArguments.inventory,
          globalArguments.dynamicDns,
        );
        const digest = await sha256(json);
        const siteNames = globalArguments.inventory.sites
          .filter((site) => site.enabled && site.public !== undefined)
          .map((site) => site.name)
          .sort();
        const config = { digest, json, siteNames };
        const digestHandle = await context.writeResource(
          "config",
          digest,
          config,
        );
        const currentHandle = await context.writeResource(
          "config",
          "current",
          config,
        );
        return { dataHandles: [digestHandle, currentHandle] };
      },
    },
    validate: {
      description: "Validate a rendered Caddy JSON artifact with Caddy",
      arguments: ValidateArgumentsSchema,
      execute: async (
        args: z.infer<typeof ValidateArgumentsSchema>,
        context: CaddyMethodContext,
      ) => {
        const validatedArgs = ValidateArgumentsSchema.parse(args);
        const resource = await context.readResource(validatedArgs.configName);
        if (resource === null || typeof resource.json !== "string") {
          throw new Error(
            `Rendered Caddy configuration ${validatedArgs.configName} was not found`,
          );
        }
        await validateWithCaddy(
          resource.json,
          validatedArgs.caddyImage,
          context,
        );
        return { dataHandles: [] };
      },
    },
    apply: {
      description:
        "Validate, atomically activate, reload, and record Caddy config",
      arguments: ApplyArgumentsSchema,
      execute: async (
        args: z.infer<typeof ApplyArgumentsSchema>,
        context: CaddyMethodContext,
      ) => {
        const applyArgs = ApplyArgumentsSchema.parse(args);
        const globalArguments = ConfigGlobalArgumentsSchema.parse(
          context.globalArgs,
        );
        const remote = globalArguments.remote ?? applyArgs.remote;
        if (remote === undefined) {
          throw new Error("Caddy deployment requires a remote fleet and host");
        }
        const resource = await context.readResource(applyArgs.configName);
        if (
          resource === null || typeof resource.json !== "string" ||
          typeof resource.digest !== "string"
        ) {
          throw new Error(
            `Rendered Caddy configuration ${applyArgs.configName} was not found`,
          );
        }
        const digest = resource.digest;
        await validateWithCaddy(
          resource.json,
          globalArguments.caddyImage,
          context,
        );

        const candidatePath = remotePath(
          globalArguments.configDirectory,
          "caddy.json.next",
        );
        const activePath = remotePath(
          globalArguments.configDirectory,
          "caddy.json",
        );
        const previousPath = remotePath(
          globalArguments.configDirectory,
          "caddy.json.previous",
        );
        let activated = false;
        let hadPrevious = false;
        try {
          await ensureDir(
            context,
            remote.fleet,
            remote.host,
            globalArguments.configDirectory,
            "system",
            remote.sudo,
            globalArguments.timeoutSeconds,
          );
          await uploadFile(
            context,
            remote.fleet,
            remote.host,
            candidatePath,
            resource.json,
            "system",
            remote.sudo,
            globalArguments.timeoutSeconds,
          );
          const remoteValidation = await runRemoteExec(
            context,
            remote.fleet,
            remote.host,
            {
              command: [
                "podman",
                "run",
                "--rm",
                "--volume",
                `${candidatePath}:/etc/caddy/caddy.json:ro,Z`,
                "--secret",
                "cloudflare-api-token,type=env,target=CLOUDFLARE_API_TOKEN",
                globalArguments.caddyImage,
                "caddy",
                "validate",
                "--config",
                "/etc/caddy/caddy.json",
                "--adapter",
                "json",
              ].map(shlexQuote).join(" "),
              sudo: remote.sudo,
              timeoutSec: globalArguments.timeoutSeconds,
            },
          );
          if (remoteValidation.exitCode !== 0) {
            throw new Error(
              `Athena rejected the Caddy candidate: ${remoteValidation.stderr}`,
            );
          }

          const previousState = await runRemoteExec(
            context,
            remote.fleet,
            remote.host,
            {
              command: `test -f ${shlexQuote(activePath)}`,
              sudo: remote.sudo,
              okExitCodes: [0, 1],
              timeoutSec: globalArguments.timeoutSeconds,
            },
          );
          hadPrevious = previousState.exitCode === 0;
          const backupCommand = hadPrevious
            ? `cp -f ${shlexQuote(activePath)} ${shlexQuote(previousPath)}`
            : `rm -f ${shlexQuote(previousPath)}`;
          const backup = await runRemoteExec(
            context,
            remote.fleet,
            remote.host,
            {
              command: backupCommand,
              sudo: remote.sudo,
              timeoutSec: globalArguments.timeoutSeconds,
            },
          );
          if (backup.exitCode !== 0) {
            throw new Error(
              `Failed to preserve the previous Caddy config: ${backup.stderr}`,
            );
          }

          const activation = await runRemoteExec(
            context,
            remote.fleet,
            remote.host,
            {
              command: `mv -f ${shlexQuote(candidatePath)} ${
                shlexQuote(activePath)
              }`,
              sudo: remote.sudo,
              timeoutSec: globalArguments.timeoutSeconds,
            },
          );
          if (activation.exitCode !== 0) {
            throw new Error(
              `Failed to activate the Caddy candidate: ${activation.stderr}`,
            );
          }
          activated = true;

          const reload = await runRemoteExec(
            context,
            remote.fleet,
            remote.host,
            {
              command: ["systemctl", "reload", globalArguments.serviceName]
                .map(shlexQuote).join(" "),
              sudo: remote.sudo,
              timeoutSec: globalArguments.timeoutSeconds,
            },
          );
          if (reload.exitCode !== 0) {
            throw new Error(`Caddy reload failed: ${reload.stderr}`);
          }

          const digestResult = await runRemoteExec(
            context,
            remote.fleet,
            remote.host,
            {
              command: `sha256sum ${shlexQuote(activePath)}`,
              sudo: remote.sudo,
              timeoutSec: globalArguments.timeoutSeconds,
            },
          );
          if (digestResult.exitCode !== 0) {
            throw new Error(
              `Failed to read the active Caddy digest: ${digestResult.stderr}`,
            );
          }
          const remoteDigest = digestResult.stdout.trim().split(/\s+/)[0];
          if (remoteDigest !== digest) {
            throw new Error(
              `Active Caddy digest ${remoteDigest} does not match rendered digest ${digest}`,
            );
          }

          const handle = await context.writeResource("deployment", "current", {
            digest,
            remoteDigest,
            candidatePath,
            activePath,
            serviceName: globalArguments.serviceName,
            backupPath: hadPrevious ? previousPath : undefined,
            rolledBack: false,
            appliedAt: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (error) {
          let rollbackFailure: unknown;
          if (activated) {
            const rollbackCommand = hadPrevious
              ? `mv -f ${shlexQuote(previousPath)} ${shlexQuote(activePath)}`
              : `rm -f ${shlexQuote(activePath)}`;
            try {
              const rollback = await runRemoteExec(
                context,
                remote.fleet,
                remote.host,
                {
                  command: rollbackCommand,
                  sudo: remote.sudo,
                  timeoutSec: globalArguments.timeoutSeconds,
                },
              );
              if (rollback.exitCode !== 0) {
                rollbackFailure = new Error(
                  `Rollback file operation failed: ${rollback.stderr}`,
                );
              }
            } catch (rollbackError) {
              rollbackFailure = rollbackError;
            }
            try {
              const rollbackReload = await runRemoteExec(
                context,
                remote.fleet,
                remote.host,
                {
                  command: ["systemctl", "reload", globalArguments.serviceName]
                    .map(shlexQuote).join(" "),
                  sudo: remote.sudo,
                  okExitCodes: "any",
                  timeoutSec: globalArguments.timeoutSeconds,
                },
              );
              if (
                rollbackReload.exitCode !== 0 && rollbackFailure === undefined
              ) {
                rollbackFailure = new Error(
                  `Rollback reload failed: ${rollbackReload.stderr}`,
                );
              }
            } catch (rollbackError) {
              if (rollbackFailure === undefined) {
                rollbackFailure = rollbackError;
              }
            }
          }
          if (rollbackFailure !== undefined) {
            throw new Error(
              `${String(error)}; rollback failed: ${String(rollbackFailure)}`,
            );
          }
          throw error;
        } finally {
          const cleanup = await runRemoteExec(
            context,
            remote.fleet,
            remote.host,
            {
              command: `rm -f ${shlexQuote(candidatePath)}`,
              sudo: remote.sudo,
              okExitCodes: "any",
              timeoutSec: globalArguments.timeoutSeconds,
            },
          );
          if (cleanup.exitCode !== 0) {
            throw new Error(
              `Failed to remove the Caddy candidate ${candidatePath}: ${cleanup.stderr}`,
            );
          }
        }
      },
    },
  },
};
