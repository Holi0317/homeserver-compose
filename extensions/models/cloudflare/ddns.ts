import { z } from "npm:zod@4";
import { runRemoteExec, shlexQuote } from "@holi0317/remote-ssh";
import type { RemoteContext } from "@holi0317/remote-ssh";

const RemoteSchema = z.strictObject({
  fleet: z.string().min(1),
  host: z.string().min(1),
  sudo: z.boolean().default(true),
});

export const ManagedRecordSchema = z.strictObject({
  name: z.string().min(1).max(253).regex(
    /^(?:@|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/,
    "must be an ASCII DNS name or @",
  ),
  type: z.enum(["A", "AAAA"]),
  ttl: z.number().int().min(1).max(86400).default(300),
  proxied: z.boolean().default(false),
  comment: z.string().max(500).optional(),
});

const GlobalArgumentsSchema = z.strictObject({
  apiToken: z.string().min(1).meta({ sensitive: true }),
  zoneId: z.string().min(1),
  remote: RemoteSchema,
  records: z.array(ManagedRecordSchema).min(1),
  ipv4Endpoint: z.string().url().default("https://api.ipify.org"),
  ipv6Endpoint: z.string().url().default("https://api6.ipify.org"),
  timeoutSeconds: z.number().int().positive().default(30),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
export type ManagedRecord = z.infer<typeof ManagedRecordSchema>;

const CloudflareRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["A", "AAAA"]),
  content: z.string().min(1),
  ttl: z.number().int().positive(),
  proxied: z.boolean(),
  comment: z.string().nullable().optional(),
});

type CloudflareRecord = z.infer<typeof CloudflareRecordSchema>;

const SyncRecordSchema = z.strictObject({
  name: z.string().min(1),
  type: z.enum(["A", "AAAA"]),
  address: z.string().min(1),
  recordId: z.string().min(1),
  action: z.enum(["created", "updated", "unchanged"]),
  verified: z.boolean(),
});

const SyncStateSchema = z.strictObject({
  zoneId: z.string().min(1),
  records: z.array(SyncRecordSchema),
  syncedAt: z.iso.datetime(),
});

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; total_pages: number };
}

interface DdnsContext extends RemoteContext {
  globalArgs: unknown;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

export function isAddress(type: "A" | "AAAA", value: string): boolean {
  if (type === "A") {
    const octets = value.split(".");
    return octets.length === 4 && octets.every((octet) => {
      if (!/^\d{1,3}$/.test(octet)) return false;
      const number = Number(octet);
      return number >= 0 && number <= 255 && String(number) === octet;
    });
  }
  if (value.length === 0 || value.includes("%")) return false;
  const sections = value.split("::");
  if (sections.length > 2) return false;
  const validGroup = (group: string) => /^[0-9A-Fa-f]{1,4}$/.test(group);
  const left = sections[0] === "" ? [] : sections[0].split(":");
  const right = sections.length === 2 && sections[1] !== ""
    ? sections[1].split(":")
    : [];
  if (!left.every(validGroup) || !right.every(validGroup)) return false;
  return sections.length === 2
    ? left.length + right.length < 8
    : left.length === 8;
}
function comparableAddress(type: "A" | "AAAA", value: string): string {
  if (type === "A") return value;
  if (!isAddress(type, value)) {
    throw new Error(`Invalid ${type} address ${value}`);
  }
  const sections = value.split("::");
  const left = sections[0] === "" ? [] : sections[0].split(":");
  const right = sections.length === 2 && sections[1] !== ""
    ? sections[1].split(":")
    : [];
  const zeros = sections.length === 2 ? 8 - left.length - right.length : 0;
  return [
    ...left,
    ...Array.from({ length: zeros }, () => "0"),
    ...right,
  ].map((group) => Number.parseInt(group, 16).toString(16)).join(":");
}

function recordKey(record: { name: string; type: "A" | "AAAA" }): string {
  return `${record.type}:${record.name.toLowerCase()}`;
}

function assertUniqueManagedRecords(records: ManagedRecord[]): void {
  const keys = new Set<string>();
  for (const record of records) {
    const key = recordKey(record);
    if (keys.has(key)) throw new Error(`Duplicate managed DNS record ${key}`);
    keys.add(key);
  }
}

export function planRecordAction(
  desired: ManagedRecord,
  address: string,
  current: CloudflareRecord | undefined,
): "created" | "updated" | "unchanged" {
  if (current === undefined) return "created";
  if (
    comparableAddress(current.type, current.content) !==
      comparableAddress(desired.type, address) ||
    current.ttl !== desired.ttl ||
    current.proxied !== desired.proxied ||
    (desired.comment !== undefined && current.comment !== desired.comment)
  ) return "updated";
  return "unchanged";
}

async function cloudflareRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<CloudflareResponse<T>> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json() as CloudflareResponse<T>;
  if (!response.ok || !result.success) {
    const details = result.errors.map((error) => error.message).join(", ");
    throw new Error(`Cloudflare ${method} ${path} failed: ${details}`);
  }
  return result;
}

async function listRecords(
  token: string,
  zoneId: string,
): Promise<CloudflareRecord[]> {
  const records: CloudflareRecord[] = [];
  let page = 1;
  while (true) {
    const response = await cloudflareRequest<unknown[]>(
      token,
      "GET",
      `/zones/${
        encodeURIComponent(zoneId)
      }/dns_records?per_page=100&page=${page}`,
    );
    for (const raw of response.result) {
      if (typeof raw !== "object" || raw === null || !("type" in raw)) {
        continue;
      }
      if (raw.type !== "A" && raw.type !== "AAAA") continue;
      records.push(CloudflareRecordSchema.parse(raw));
    }
    if (
      response.result_info === undefined ||
      page >= response.result_info.total_pages
    ) break;
    page += 1;
  }
  return records;
}

async function discoverAddress(
  context: DdnsContext,
  globalArgs: GlobalArguments,
  type: "A" | "AAAA",
): Promise<string> {
  const endpoint = type === "A"
    ? globalArgs.ipv4Endpoint
    : globalArgs.ipv6Endpoint;
  const result = await runRemoteExec(
    context,
    globalArgs.remote.fleet,
    globalArgs.remote.host,
    {
      command: [
        "curl",
        type === "A" ? "-4" : "-6",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "10",
        endpoint,
      ].map(shlexQuote).join(" "),
      timeoutSec: globalArgs.timeoutSeconds,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to discover Athena ${type} address: ${result.stderr}`,
    );
  }
  const address = result.stdout.trim();
  if (!isAddress(type, address)) {
    throw new Error(`Address discovery returned invalid ${type} value`);
  }
  return address;
}

function mutationPayload(
  desired: ManagedRecord,
  address: string,
  current?: CloudflareRecord,
): Record<string, unknown> {
  return {
    type: desired.type,
    name: desired.name,
    content: address,
    ttl: desired.ttl,
    proxied: desired.proxied,
    comment: desired.comment ?? current?.comment ?? null,
  };
}

export const model = {
  type: "@holi0317/cloudflare/ddns",
  version: "2026.08.18.1",
  globalArguments: GlobalArgumentsSchema,
  resources: {
    sync: {
      description: "Verified Cloudflare DDNS convergence state",
      schema: SyncStateSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description: "Converge only the explicitly managed A and AAAA records",
      arguments: GlobalArgumentsSchema,
      execute: async (_args: GlobalArguments, context: DdnsContext) => {
        const globalArgs = GlobalArgumentsSchema.parse(context.globalArgs);
        assertUniqueManagedRecords(globalArgs.records);
        const managedKeys = new Set(globalArgs.records.map(recordKey));
        const existing = await listRecords(
          globalArgs.apiToken,
          globalArgs.zoneId,
        );
        const existingByKey = new Map<string, CloudflareRecord>();
        for (const record of existing) {
          const key = recordKey(record);
          if (!managedKeys.has(key)) continue;
          if (existingByKey.has(key)) {
            throw new Error(`Cloudflare has duplicate managed record ${key}`);
          }
          existingByKey.set(key, record);
        }
        const addresses = new Map<"A" | "AAAA", string>();
        for (
          const type of new Set(globalArgs.records.map((record) => record.type))
        ) {
          addresses.set(type, await discoverAddress(context, globalArgs, type));
        }

        const expectedById = new Map<string, {
          desired: ManagedRecord;
          address: string;
        }>();

        const results: Array<Record<string, unknown>> = [];
        for (const desired of globalArgs.records) {
          const address = addresses.get(desired.type);
          if (address === undefined) {
            throw new Error(`Address for ${desired.type} was not discovered`);
          }
          const current = existingByKey.get(recordKey(desired));
          const action = planRecordAction(desired, address, current);
          let recordId = current?.id;
          if (action === "created") {
            const response = await cloudflareRequest<CloudflareRecord>(
              globalArgs.apiToken,
              "POST",
              `/zones/${encodeURIComponent(globalArgs.zoneId)}/dns_records`,
              mutationPayload(desired, address),
            );
            recordId = CloudflareRecordSchema.parse(response.result).id;
          } else if (action === "updated") {
            if (recordId === undefined) {
              throw new Error("Managed record ID is missing");
            }
            await cloudflareRequest<CloudflareRecord>(
              globalArgs.apiToken,
              "PUT",
              `/zones/${encodeURIComponent(globalArgs.zoneId)}/dns_records/${
                encodeURIComponent(recordId)
              }`,
              mutationPayload(desired, address, current),
            );
          }
          if (recordId === undefined) {
            throw new Error("Cloudflare did not return a record ID");
          }
          expectedById.set(recordId, { desired, address });
          results.push({
            name: desired.name,
            type: desired.type,
            address,
            recordId,
            action,
            verified: false,
          });
        }

        const verifiedRecords = await listRecords(
          globalArgs.apiToken,
          globalArgs.zoneId,
        );
        const verifiedById = new Map(
          verifiedRecords.map((record) => [record.id, record]),
        );
        for (const result of results) {
          const current = verifiedById.get(String(result.recordId));
          const expected = expectedById.get(String(result.recordId));
          if (
            current === undefined ||
            expected === undefined ||
            comparableAddress(current.type, current.content) !==
              comparableAddress(expected.desired.type, expected.address) ||
            current.type !== expected.desired.type ||
            current.name.toLowerCase() !==
              expected.desired.name.toLowerCase() ||
            current.ttl !== expected.desired.ttl ||
            current.proxied !== expected.desired.proxied ||
            (expected.desired.comment !== undefined &&
              current.comment !== expected.desired.comment)
          ) {
            throw new Error(
              `Cloudflare verification failed for ${result.type}:${result.name}`,
            );
          }
          result.verified = true;
        }

        const handle = await context.writeResource("sync", "current", {
          zoneId: globalArgs.zoneId,
          records: results,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
