// Shared plumbing for the @holi0317/zitadel resource models.
//
// Each model file (project.ts, oidc_app.ts, …) manages ONE Zitadel resource
// kind with the repo's declarative lifecycle: `check` (observe), `apply`
// (create-or-converge), `destroy` (gated hard delete). This module holds
// everything they share: the auth seam (JWT private-key service account over
// the Management API v1), pagination, finders, friendly⇆wire enum maps, and
// pure drift comparators that unit tests exercise without any network.
//
// Signing uses the Web Crypto API (the `crypto.subtle` global) — NO node:
// import, so the extension has zero dependencies AND resolves no `@types/node`
// at doc-lint time. Zitadel issues PKCS#1 ("RSA PRIVATE KEY") keys and Web
// Crypto imports only PKCS#8, so `signAssertion` wraps PKCS#1 → PKCS#8.

import { z } from "zod";

/** CalVer version shared by every model in this extension; mirrors manifest.yaml. */
export const MODEL_VERSION = "2026.09.25.2";

// ─────────────────────────── shared target schema ───────────────────────────

const DEFAULT_TOKEN_SCOPE =
  "openid profile urn:zitadel:iam:org:project:id:zitadel:aud";
export const ZitadelTargetSchema = z.object({
  apiUrl: z.string().describe(
    "Zitadel base URL / issuer, e.g. https://zitadel.example.com",
  ),
  keyJson: z.string().meta({ sensitive: true }).describe(
    "Service-user machine key JSON (the whole blob downloaded from Zitadel; " +
      "contains keyId, key (PKCS#1 PEM), userId). Supply via vault: " +
      "${{ vault.get(<vault>, zitadel.admin-service-key) }}",
  ),
  orgId: z.string().optional().describe(
    "Target org id (x-zitadel-orgid header). Omit to use the service user's own org.",
  ),
  httpTimeoutMs: z.coerce.number().int().default(30000).describe(
    "Per-request timeout (ms) for token exchange and API calls",
  ),
  tokenScope: z.string().default(DEFAULT_TOKEN_SCOPE).describe(
    "OAuth scope requested for the API token (advanced). The project:id:zitadel:aud " +
      "scope is what grants access to Zitadel's own Management API.",
  ),
});

export type ZitadelTarget = z.infer<typeof ZitadelTargetSchema>;

/** Narrowly-typed method context (only the fields the models use). */
export interface ZitadelMethodContext<GlobalArgs extends ZitadelTarget> {
  globalArgs: GlobalArgs;
  logger?: {
    info?(message: string, ...args: unknown[]): void;
    warn?(message: string, ...args: unknown[]): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Outcome verbs reported in state artifacts. */
export type Action =
  | "created"
  | "unchanged"
  | "updated"
  | "rotated"
  | "removed"
  | "observed";

// ─────────────────────────── HTTP / auth seam ───────────────────────────

/** A JSON-ish bag — structurally the resolved global args or an API body. */
export type Json = Record<string, unknown>;

/** One Management-API request: method + path (relative to `apiUrl`) + optional JSON body. */
export interface ApiCall {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Json;
}

/** The parsed result of an {@link ApiCall}. */
export interface ApiResult {
  status: number;
  body: Json;
}

/**
 * The authenticated-call seam the models use — swappable for unit tests. The
 * default implementation signs a short-lived RS256 assertion and exchanges it
 * for an access token per {@link getToken}.
 */
export type CallerFn = (g: Json, call: ApiCall) => Promise<ApiResult>;

let _callerOverride: CallerFn | null = null;

/** Test-only seam: substitute the API caller. Pass `null` to restore the real one. */
export function __setCaller(fn: CallerFn | null): void {
  _callerOverride = fn;
}

/** Parsed Zitadel machine-key JSON. */
export interface KeyJson {
  keyId: string;
  key: string;
  userId?: string;
  clientId?: string;
}

export function parseKeyJson(raw: string): KeyJson {
  let k: Partial<KeyJson>;
  try {
    k = JSON.parse(raw) as Partial<KeyJson>;
  } catch {
    throw new Error("keyJson is not valid JSON");
  }
  const subject = k.userId ?? k.clientId;
  if (!k.keyId || !k.key || !subject) {
    throw new Error("keyJson missing required keyId / key / userId");
  }
  return { keyId: k.keyId, key: k.key, userId: k.userId, clientId: k.clientId };
}

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function baseUrl(g: ZitadelTarget): string {
  return g.apiUrl.replace(/\/+$/, "");
}

/**
 * Build the JWT-bearer assertion claims for the service account. Pure (no crypto)
 * so it is unit-testable: `iss`/`sub` are the service user, `aud` is the issuer,
 * and the token lives ≤ 1 hour. Exported for tests.
 */
export function jwtAssertionClaims(
  keyJson: Json,
  apiUrl: string,
  nowSec: number,
): Json {
  const k = parseKeyJson(JSON.stringify(keyJson));
  const subject = k.userId ?? k.clientId;
  return {
    iss: subject,
    sub: subject,
    aud: apiUrl.replace(/\/+$/, ""),
    iat: nowSec,
    exp: nowSec + 3600,
  };
}

/** Decode a PEM block's base64 body to DER bytes; flags whether it's PKCS#8. */
function pemToDer(pem: string): { der: Uint8Array; isPkcs8: boolean } {
  const isPkcs8 = /BEGIN PRIVATE KEY/.test(pem);
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, isPkcs8 };
}

/** DER length octets for a content length (short form < 128, else long form). */
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/**
 * Wrap a PKCS#1 `RSAPrivateKey` DER in the PKCS#8 `PrivateKeyInfo` envelope
 * (`SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }`),
 * so Web Crypto's `importKey("pkcs8", …)` accepts a Zitadel-issued PKCS#1 key.
 * Pure byte-surgery, deterministic, no dependencies. Exported for tests.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const algId = [
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length), ...pkcs1];
  const body = [...version, ...algId, ...octet];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]);
}

/**
 * Import a PEM RSA private key (PKCS#1 or PKCS#8) as an RS256 signing key via
 * Web Crypto. Exported for tests. Zitadel keys are PKCS#1 → wrapped to PKCS#8.
 */
export async function importSigningKey(pemKey: string): Promise<CryptoKey> {
  const { der, isPkcs8 } = pemToDer(pemKey);
  const pkcs8 = isPkcs8 ? der : pkcs1ToPkcs8(der);
  // Back the key bytes with a plain ArrayBuffer — a Uint8Array<ArrayBufferLike>
  // is not accepted as BufferSource (it could be SharedArrayBuffer-backed).
  const buf = new ArrayBuffer(pkcs8.byteLength);
  new Uint8Array(buf).set(pkcs8);
  return await crypto.subtle.importKey(
    "pkcs8",
    buf,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signAssertion(
  k: KeyJson,
  apiUrl: string,
  nowSec: number,
): Promise<string> {
  const header = b64url(
    JSON.stringify({ alg: "RS256", kid: k.keyId, typ: "JWT" }),
  );
  const payload = b64url(
    JSON.stringify(jwtAssertionClaims({ ...k }, apiUrl, nowSec)),
  );
  const input = `${header}.${payload}`;
  const key = await importSigningKey(k.key);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  // Pre-flight checks receive RAW global args (schema defaults not applied),
  // so an undefined/0 timeout here means "no value", not "abort now".
  const t = setTimeout(
    () => ctrl.abort(),
    timeoutMs > 0 ? timeoutMs : 30000,
  );
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

interface CachedToken {
  token: string;
  expSec: number;
}
const _tokenCache = new Map<string, CachedToken>();

export async function getToken(g: ZitadelTarget): Promise<string> {
  const k = parseKeyJson(g.keyJson);
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = _tokenCache.get(k.keyId);
  if (cached && cached.expSec - 60 > nowSec) return cached.token;
  const assertion = await signAssertion(k, g.apiUrl, nowSec);
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    // Pre-flight checks receive RAW global args (schema defaults not yet
    // applied) — a missing scope would mint an audience-less token that the
    // Management API rejects with 401, then get cached here. Normalize.
    scope: typeof g.tokenScope === "string" && g.tokenScope
      ? g.tokenScope
      : DEFAULT_TOKEN_SCOPE,
    assertion,
  });
  const res = await fetchWithTimeout(
    `${baseUrl(g)}/oauth/v2/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    g.httpTimeoutMs,
  );
  const text = await res.text();
  if (res.status >= 400) {
    throw new Error(
      `Zitadel token exchange failed: HTTP ${res.status}: ${text}`,
    );
  }
  const j = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!j.access_token) {
    throw new Error("token exchange returned no access_token");
  }
  _tokenCache.set(k.keyId, {
    token: j.access_token,
    expSec: nowSec + (j.expires_in ?? 3600),
  });
  return j.access_token;
}

/** The real fetch-backed implementation behind {@link call}. */
async function realCaller(g: ZitadelTarget, c: ApiCall): Promise<ApiResult> {
  const token = await getToken(g);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (g.orgId) headers["x-zitadel-orgid"] = g.orgId;
  let body: string | undefined;
  if (c.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(c.body);
  }
  const res = await fetchWithTimeout(
    `${baseUrl(g)}${c.path}`,
    { method: c.method, headers, body },
    g.httpTimeoutMs,
  );
  const text = await res.text();
  let parsed: Json = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      parsed = { raw: text };
    }
  }
  if (res.status >= 400) {
    const msg = typeof parsed.message === "string" ? parsed.message : text;
    throw new Error(
      `Zitadel API ${c.method} ${c.path} -> HTTP ${res.status}: ${msg}`,
    );
  }
  return { status: res.status, body: parsed };
}

export function call(g: ZitadelTarget, c: ApiCall): Promise<ApiResult> {
  return (_callerOverride ?? realCaller)(g, c);
}

// ─────────────────────────── helpers ───────────────────────────

export function logInfo(
  context: Pick<ZitadelMethodContext<ZitadelTarget>, "logger">,
  message: string,
  props?: Record<string, unknown>,
): void {
  context.logger?.info?.(message, props ?? {});
}

export function mgmt(path: string): string {
  return `/management/v1${path}`;
}

export function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Page through a Zitadel `_search` endpoint and return ALL results (not just the
 * first page). Zitadel returns `details.totalResult` as a string; we loop on
 * offset until the accumulated count reaches it or a short page is returned.
 */
export async function searchAll(
  g: ZitadelTarget,
  path: string,
  queries?: Json[],
): Promise<Json[]> {
  const limit = 100;
  let offset = 0;
  const all: Json[] = [];
  // Bounded loop: stop on a short page, a reached total, or a sanity guard.
  for (let guard = 0; guard < 1000; guard++) {
    const body: Json = { query: { offset, limit, asc: true } };
    if (queries && queries.length) body.queries = queries;
    const r = await call(g, { method: "POST", path, body });
    const page = asArray(r.body.result);
    all.push(...page);
    const details = (r.body.details ?? {}) as Json;
    const total = Number(details.totalResult);
    offset += page.length;
    if (page.length < limit) break;
    if (Number.isFinite(total) && all.length >= total) break;
    if (page.length === 0) break;
  }
  return all;
}

// ─────────────────────────── friendly ⇆ zitadel enums ───────────────────────────

/** Friendly OIDC application type → Zitadel enum. */
export const APP_TYPE: Record<string, string> = {
  web: "OIDC_APP_TYPE_WEB",
  spa: "OIDC_APP_TYPE_USER_AGENT",
  native: "OIDC_APP_TYPE_NATIVE",
};
/** Friendly OIDC auth method → Zitadel enum. */
export const AUTH_METHOD: Record<string, string> = {
  basic: "OIDC_AUTH_METHOD_TYPE_BASIC",
  post: "OIDC_AUTH_METHOD_TYPE_POST",
  none: "OIDC_AUTH_METHOD_TYPE_NONE",
  jwt: "OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT",
};
/** Friendly API-app auth method → Zitadel enum. */
export const API_AUTH_METHOD: Record<string, string> = {
  basic: "API_AUTH_METHOD_TYPE_BASIC",
  jwt: "API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT",
};
/** Friendly OIDC grant type → Zitadel enum. */
export const GRANT_TYPE: Record<string, string> = {
  authorization_code: "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
  implicit: "OIDC_GRANT_TYPE_IMPLICIT",
  refresh_token: "OIDC_GRANT_TYPE_REFRESH_TOKEN",
  device_code: "OIDC_GRANT_TYPE_DEVICE_CODE",
};
/** Friendly OIDC response type → Zitadel enum. */
export const RESPONSE_TYPE: Record<string, string> = {
  code: "OIDC_RESPONSE_TYPE_CODE",
  id_token: "OIDC_RESPONSE_TYPE_ID_TOKEN",
  id_token_token: "OIDC_RESPONSE_TYPE_ID_TOKEN_TOKEN",
};
/** Friendly access-token type → Zitadel enum. */
export const ACCESS_TOKEN_TYPE: Record<string, string> = {
  bearer: "OIDC_TOKEN_TYPE_BEARER",
  jwt: "OIDC_TOKEN_TYPE_JWT",
};

/** Invert a friendly→Zitadel enum map for read-shaping (Zitadel enum → friendly). */
function invertEnum(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
}

export const APP_TYPE_REV = invertEnum(APP_TYPE);
export const ACCESS_TOKEN_TYPE_REV = invertEnum(ACCESS_TOKEN_TYPE);
export const RESPONSE_TYPE_REV = invertEnum(RESPONSE_TYPE);
export const GRANT_TYPE_REV = invertEnum(GRANT_TYPE);

/** Reduce a Zitadel state enum (e.g. `APP_STATE_ACTIVE`) to `active`/`inactive`/… */
export function friendlyState(s: unknown): string {
  if (typeof s !== "string" || !s) return "unknown";
  const parts = s.split("_");
  return parts[parts.length - 1].toLowerCase();
}

/** Reverse-map a wire enum array to friendly values (friendlyState fallback). */
export function friendlyEnumArr(
  v: unknown,
  rev: Record<string, string>,
): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((e) =>
    typeof e === "string" ? (rev[e] ?? friendlyState(e)) : String(e)
  );
}

export function mapEnum(
  m: Record<string, string>,
  v: string,
  label: string,
): string {
  const out = m[v];
  if (!out) {
    throw new Error(
      `Invalid ${label} ${JSON.stringify(v)}; allowed: ${
        Object.keys(m).join(", ")
      }`,
    );
  }
  return out;
}

// ─────────────────────────── resource finders ───────────────────────────

/** A plain numeric Zitadel id is used as-is; anything else is treated as a name. */
export function looksLikeId(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

/** Find a project by exact name; returns the raw project object or null. */
export async function findProjectByName(
  g: ZitadelTarget,
  name: string,
): Promise<Json | null> {
  const r = await call(g, {
    method: "POST",
    path: mgmt("/projects/_search"),
    body: {
      queries: [{
        nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" },
      }],
    },
  });
  const result = asArray(r.body.result);
  return result.find((p) => p.name === name) ?? result[0] ?? null;
}

/**
 * Resolve a project reference (numeric id OR exact name) to its id WITHOUT
 * creating it. Referencing models must not implicitly create their project —
 * a missing project is an error pointing at the project model.
 */
export async function resolveProjectId(
  g: ZitadelTarget,
  project: string,
): Promise<string> {
  if (looksLikeId(project)) return project;
  const p = await findProjectByName(g, project);
  if (!p || typeof p.id !== "string") {
    throw new Error(
      `Project ${JSON.stringify(project)} does not exist; apply the ` +
        `@holi0317/zitadel/project model for it first`,
    );
  }
  return p.id;
}

/** Find an application by exact name within a project; returns it or null. */
export async function findAppByName(
  g: ZitadelTarget,
  projectId: string,
  name: string,
): Promise<Json | null> {
  const r = await call(g, {
    method: "POST",
    path: mgmt(`/projects/${encodeURIComponent(projectId)}/apps/_search`),
    body: {
      queries: [{
        nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" },
      }],
    },
  });
  const result = asArray(r.body.result);
  return result.find((a) => a.name === name) ?? null;
}

/** Find a machine user by exact username; returns it or null. */
export async function findMachineUserByUsername(
  g: ZitadelTarget,
  userName: string,
): Promise<Json | null> {
  const r = await call(g, {
    method: "POST",
    path: mgmt("/users/_search"),
    body: {
      queries: [{
        userNameQuery: { userName, method: "TEXT_QUERY_METHOD_EQUALS" },
      }],
    },
  });
  const result = asArray(r.body.result);
  return result.find((u) => u.userName === userName) ?? result[0] ?? null;
}

/** Resolve a machine-user reference (numeric id OR username) to a user id. */
export async function resolveUserId(
  g: ZitadelTarget,
  userRef: string,
): Promise<string> {
  if (looksLikeId(userRef)) return userRef;
  const u = await findMachineUserByUsername(g, userRef);
  // ListUsers result objects use `id`; AddMachineUser returns `userId`. Accept either.
  const uid = u ? (u.id ?? u.userId) : undefined;
  if (typeof uid !== "string") {
    throw new Error(
      `No machine user found with username ${JSON.stringify(userRef)}; apply ` +
        `the @holi0317/zitadel/machine-user model for it first`,
    );
  }
  return uid;
}

/** Find a project role by exact key within a project; returns it or null. */
export async function findRoleByKey(
  g: ZitadelTarget,
  projectId: string,
  roleKey: string,
): Promise<Json | null> {
  const r = await call(g, {
    method: "POST",
    path: mgmt(`/projects/${encodeURIComponent(projectId)}/roles/_search`),
    body: {
      queries: [{
        keyQuery: { key: roleKey, method: "TEXT_QUERY_METHOD_EQUALS" },
      }],
    },
  });
  // Role-search results key on `key`; match exactly (the query is a contains-ish filter).
  return asArray(r.body.result).find((ro) => ro.key === roleKey) ?? null;
}

/** Find a user grant by (userId, projectId); returns the raw grant or null. */
export async function findGrant(
  g: ZitadelTarget,
  userId: string,
  projectId: string,
): Promise<Json | null> {
  const r = await call(g, {
    method: "POST",
    path: mgmt("/users/grants/_search"),
    body: {
      queries: [
        { userIdQuery: { userId } },
        { projectIdQuery: { projectId } },
      ],
    },
  });
  return asArray(r.body.result).find((gr) =>
    gr.userId === userId && gr.projectId === projectId
  ) ?? null;
}

// ─────────────────────────── shared argument helpers ───────────────────────────

/**
 * An array argument that also accepts a JSON-encoded string (so the raw CLI
 * `--input key=["a","b"]` works); a real array (from CEL/workflows) passes through.
 */
export function jsonArray<T extends z.ZodTypeAny>(item: T): z.ZodType<
  z.infer<T>[]
> {
  return z.preprocess(
    (v) => {
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      }
      return v;
    },
    z.array(item),
  ) as unknown as z.ZodType<z.infer<T>[]>;
}

/** A boolean argument that also accepts the strings "true"/"false" (raw CLI). */
export function boolArg(def: boolean): z.ZodType<boolean> {
  return z.preprocess(
    (v) => v === "true" ? true : v === "false" ? false : v,
    z.boolean().default(def),
  ) as unknown as z.ZodType<boolean>;
}

/**
 * A tri-state boolean argument: accepts true/false (and the strings "true"/
 * "false" from the raw CLI) but leaves `undefined` as `undefined` — so an omitted
 * flag means "leave as-is" rather than "set false".
 */
export function optBoolArg(): z.ZodType<boolean | undefined> {
  return z.preprocess(
    (v) => v === undefined ? undefined : v === true || v === "true",
    z.boolean().optional(),
  ) as unknown as z.ZodType<boolean | undefined>;
}

// ─────────────────────────── house-style artifacts ───────────────────────────

/** Write the shared `runResult`/`last` artifact for one method invocation. */
export function writeRunResult(
  context: Pick<ZitadelMethodContext<ZitadelTarget>, "writeResource">,
  method: string,
  changed: boolean,
  identity: Record<string, unknown>,
) {
  return context.writeResource("runResult", "last", {
    method,
    changed,
    success: true,
    timestamp: nowIso(),
    ...identity,
  });
}

/**
 * Shared `reachable` pre-flight check: verifies the instance is reachable and
 * the service-account key authenticates (token exchange). Skipped when keyJson
 * is still an unresolved vault expression (`swamp model validate` does not
 * resolve vault refs; the real check runs at method-run time).
 */
export function reachableCheck() {
  return {
    description:
      "Verify Zitadel is reachable and the service-account key authenticates (token exchange)",
    labels: ["live"],
    execute: async (context: { globalArgs: ZitadelTarget }) => {
      const g = context.globalArgs;
      if (/\$\{\{/.test(String(g.keyJson))) return { pass: true };
      try {
        await getToken(g);
        return { pass: true };
      } catch (e) {
        return {
          pass: false,
          errors: [
            `Cannot authenticate to Zitadel at ${g.apiUrl}: ${
              (e as Error).message
            }`,
          ],
        };
      }
    },
  };
}

// ─────────────────────────── OIDC config: desired ⇆ observed ───────────────────────────

/** Desired OIDC app configuration in friendly form (exactly the model's args). */
export interface OidcDesired {
  redirectUris: string[];
  postLogoutUris: string[];
  appType: string;
  authMethod: string;
  grantTypes: string[];
  responseTypes: string[];
  accessTokenType: string;
  devMode: boolean;
  idTokenRoleAssertion: boolean;
  idTokenUserinfoAssertion: boolean;
}

/** Desired config mapped to wire (Zitadel enum) values — the PUT/create body. */
export function desiredOidcWire(d: OidcDesired): Json {
  return {
    redirectUris: d.redirectUris,
    postLogoutRedirectUris: d.postLogoutUris,
    responseTypes: d.responseTypes.map((t) =>
      mapEnum(RESPONSE_TYPE, t, "responseType")
    ),
    grantTypes: d.grantTypes.map((t) => mapEnum(GRANT_TYPE, t, "grantType")),
    appType: mapEnum(APP_TYPE, d.appType, "appType"),
    authMethodType: mapEnum(AUTH_METHOD, d.authMethod, "authMethod"),
    accessTokenType: mapEnum(
      ACCESS_TOKEN_TYPE,
      d.accessTokenType,
      "accessTokenType",
    ),
    devMode: d.devMode,
    idTokenRoleAssertion: d.idTokenRoleAssertion,
    idTokenUserinfoAssertion: d.idTokenUserinfoAssertion,
  };
}

/**
 * Observed `oidcConfig` (raw API shape) normalized to the SAME wire shape as
 * {@link desiredOidcWire}, so drift comparison is a plain field diff. OIDC
 * config fields use proto3 zero-value omission: appType=web, accessTokenType=
 * bearer and devMode=false come back ABSENT — fill in the effective defaults.
 */
export function observedOidcWire(oidc: Json): Json {
  return {
    redirectUris: asArray(oidc.redirectUris).map(String),
    postLogoutRedirectUris: asArray(oidc.postLogoutRedirectUris).map(String),
    responseTypes: asArray(oidc.responseTypes).map(String),
    grantTypes: asArray(oidc.grantTypes).map(String),
    appType: typeof oidc.appType === "string"
      ? oidc.appType
      : "OIDC_APP_TYPE_WEB",
    authMethodType: typeof oidc.authMethodType === "string"
      ? oidc.authMethodType
      : undefined,
    accessTokenType: typeof oidc.accessTokenType === "string"
      ? oidc.accessTokenType
      : "OIDC_TOKEN_TYPE_BEARER",
    devMode: typeof oidc.devMode === "boolean" ? oidc.devMode : false,
    idTokenRoleAssertion: typeof oidc.idTokenRoleAssertion === "boolean"
      ? oidc.idTokenRoleAssertion
      : false,
    idTokenUserinfoAssertion: typeof oidc.idTokenUserinfoAssertion === "boolean"
      ? oidc.idTokenUserinfoAssertion
      : false,
  };
}

/**
 * Compare desired (wire) vs observed (wire) OIDC config. URI lists and enum
 * arrays compare order-insensitively (Zitadel does not ascribe meaning to list
 * order); scalars compare exactly. Returns the drifted field names — empty
 * means the app already matches. Conservative by design: an ordering-only or
 * proto3-omission artifact may report drift, and apply's "no changes" tolerance
 * then resolves it without mutating anything.
 */
export function oidcDrift(desired: Json, observed: Json): string[] {
  const drifted: string[] = [];
  const cmp = (field: string, want: unknown, got: unknown) => {
    if (want !== got) drifted.push(field);
  };
  const cmpSet = (field: string, want: string[], got: string[]) => {
    const w = [...want].sort();
    const o = [...got].sort();
    if (w.length !== o.length || w.some((v, i) => v !== o[i])) {
      drifted.push(field);
    }
  };
  cmpSet(
    "redirectUris",
    desired.redirectUris as string[],
    observed.redirectUris as string[],
  );
  cmpSet(
    "postLogoutRedirectUris",
    desired.postLogoutRedirectUris as string[],
    observed.postLogoutRedirectUris as string[],
  );
  cmpSet(
    "responseTypes",
    desired.responseTypes as string[],
    observed.responseTypes as string[],
  );
  cmpSet(
    "grantTypes",
    desired.grantTypes as string[],
    observed.grantTypes as string[],
  );
  cmp("appType", desired.appType, observed.appType);
  // Only flag authMethodType when the desired value is known; an absent
  // observed value with a desired value converges on apply.
  if (
    typeof desired.authMethodType === "string" &&
    desired.authMethodType !== observed.authMethodType
  ) {
    drifted.push("authMethodType");
  }
  cmp(
    "accessTokenType",
    desired.accessTokenType,
    observed.accessTokenType,
  );
  cmp("devMode", desired.devMode, observed.devMode);
  cmp(
    "idTokenRoleAssertion",
    desired.idTokenRoleAssertion,
    observed.idTokenRoleAssertion,
  );
  cmp(
    "idTokenUserinfoAssertion",
    desired.idTokenUserinfoAssertion,
    observed.idTokenUserinfoAssertion,
  );
  return drifted;
}

/** Friendly OIDC config shaping for state artifacts (reads back through the reverse maps). */
export function observedOidcFriendly(oidc: Json): Record<string, unknown> {
  const wire = observedOidcWire(oidc);
  return {
    appType: APP_TYPE_REV[wire.appType as string] ??
      friendlyState(wire.appType),
    authMethod: typeof wire.authMethodType === "string"
      ? (AUTH_METHOD[wire.authMethodType as string]
        ? wire.authMethodType
        : friendlyState(wire.authMethodType))
      : undefined,
    accessTokenType: ACCESS_TOKEN_TYPE_REV[wire.accessTokenType as string] ??
      friendlyState(wire.accessTokenType),
    redirectUris: wire.redirectUris,
    postLogoutUris: wire.postLogoutRedirectUris,
    grantTypes: friendlyEnumArr(wire.grantTypes, GRANT_TYPE_REV),
    responseTypes: friendlyEnumArr(wire.responseTypes, RESPONSE_TYPE_REV),
    devMode: wire.devMode,
    idTokenRoleAssertion: wire.idTokenRoleAssertion,
    idTokenUserinfoAssertion: wire.idTokenUserinfoAssertion,
  };
}
