import {
  desiredOidcWire,
  importSigningKey,
  jwtAssertionClaims,
  mapEnum,
  observedOidcWire,
  type OidcDesired,
  oidcDrift,
  pkcs1ToPkcs8,
} from "./_lib.ts";

const DESIRED: OidcDesired = {
  redirectUris: ["https://grafana.example/login/generic_oauth"],
  postLogoutUris: [],
  appType: "web",
  authMethod: "none",
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  accessTokenType: "bearer",
  devMode: false,
};

Deno.test("desiredOidcWire maps friendly values to Zitadel enums", () => {
  const wire = desiredOidcWire(DESIRED);
  if (wire.appType !== "OIDC_APP_TYPE_WEB") {
    throw new Error(`appType not mapped: ${wire.appType}`);
  }
  if (wire.authMethodType !== "OIDC_AUTH_METHOD_TYPE_NONE") {
    throw new Error(`authMethodType not mapped: ${wire.authMethodType}`);
  }
  if (
    JSON.stringify(wire.grantTypes) !==
      '["OIDC_GRANT_TYPE_AUTHORIZATION_CODE","OIDC_GRANT_TYPE_REFRESH_TOKEN"]'
  ) {
    throw new Error(`grantTypes not mapped: ${wire.grantTypes}`);
  }
});

Deno.test("observedOidcWire fills proto3-omitted OIDC defaults", () => {
  // Zitadel omits appType=web / accessTokenType=bearer / devMode=false on read.
  const observed = observedOidcWire({
    redirectUris: ["https://grafana.example/login/generic_oauth"],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: [
      "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
      "OIDC_GRANT_TYPE_REFRESH_TOKEN",
    ],
    authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
  });
  const drift = oidcDrift(desiredOidcWire(DESIRED), observed);
  if (drift.length !== 0) {
    throw new Error(`expected no drift, got: ${drift.join(", ")}`);
  }
});

Deno.test("oidcDrift reports drifted fields and nothing else", () => {
  const desired = desiredOidcWire(DESIRED);
  const observed = observedOidcWire({
    ...desired,
    redirectUris: ["https://grafana.example/other"],
    devMode: true,
  });
  const drift = oidcDrift(desired, observed);
  if (JSON.stringify(drift) !== '["redirectUris","devMode"]') {
    throw new Error(`unexpected drift: ${drift.join(", ")}`);
  }
});

Deno.test("oidcDrift compares URI lists order-insensitively", () => {
  const desired = desiredOidcWire({
    ...DESIRED,
    redirectUris: ["https://a.example", "https://b.example"],
  });
  const observed = observedOidcWire({
    ...desired,
    redirectUris: ["https://b.example", "https://a.example"],
  });
  const drift = oidcDrift(desired, observed);
  if (drift.length !== 0) {
    throw new Error(`expected no drift, got: ${drift.join(", ")}`);
  }
});

Deno.test("mapEnum rejects unknown friendly values with allowed list", () => {
  let message = "";
  try {
    mapEnum({ web: "WEB" }, "desktop", "appType");
  } catch (e) {
    message = (e as Error).message;
  }
  if (!message.includes("desktop") || !message.includes("web")) {
    throw new Error(`unexpected error message: ${message}`);
  }
});

Deno.test("jwtAssertionClaims pins iss/sub to the service user and aud to the issuer", () => {
  const claims = jwtAssertionClaims(
    { keyId: "k1", key: "PEM", userId: "u1" },
    "https://auth.example.com/",
    1000,
  );
  if (claims.iss !== "u1" || claims.sub !== "u1") {
    throw new Error(`iss/sub wrong: ${claims.iss}/${claims.sub}`);
  }
  if (claims.aud !== "https://auth.example.com") {
    throw new Error(`aud not normalized: ${claims.aud}`);
  }
  if (claims.exp !== 4600) {
    throw new Error(`token must live 1h: ${claims.exp}`);
  }
});

Deno.test("pkcs1ToPkcs8 round-trips a real key into importable PKCS#8", async () => {
  // Generate a real RSA keypair, export PKCS#8, strip the envelope back to
  // bare PKCS#1 (what Zitadel issues), then prove pkcs1ToPkcs8 re-wraps it
  // into DER that Web Crypto imports. A broken envelope fails the import.
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  let i = 1; // skip the 0x30 tag
  const readLen = () => {
    const b = pkcs8[i++];
    if (b < 0x80) return b;
    const n = b & 0x7f;
    let v = 0;
    for (let j = 0; j < n; j++) v = v * 256 + pkcs8[i++];
    return v;
  };
  readLen(); // outer SEQUENCE
  i++; // INTEGER tag
  let len = readLen(); // version length; i now sits at the version content
  i += len;
  i++; // SEQUENCE (algId) tag
  len = readLen(); // algId length; i now sits at the algId content
  i += len;
  i++; // OCTET STRING tag
  const contentLen = readLen();
  const pkcs1 = pkcs8.slice(i, i + contentLen);

  const rewrapped = pkcs1ToPkcs8(pkcs1);
  if (pkcs8[0] !== 0x30 || rewrapped[0] !== 0x30) {
    throw new Error("pkcs8 must open with SEQUENCE");
  }
  await importSigningKey(
    "-----BEGIN PRIVATE KEY-----\n" +
      btoa(String.fromCharCode(...rewrapped)) +
      "\n-----END PRIVATE KEY-----",
  );
});
