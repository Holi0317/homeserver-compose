import {
  parsePgBoolean,
  pgIdent,
  pgLiteral,
  psqlCommand,
  scramSha256Verifier,
  shlexQuote,
} from "./_lib.ts";

Deno.test("PostgreSQL identifiers and literals are quoted safely", () => {
  if (pgIdent('role"name') !== '"role""name"') {
    throw new Error("identifier quoting is incorrect");
  }
  if (pgLiteral("secret'value") !== "'secret''value'") {
    throw new Error("literal quoting is incorrect");
  }
  if (shlexQuote("a'b") !== "'a'\\''b'") {
    throw new Error("shell quoting is incorrect");
  }
});

Deno.test("psql commands are plain argv chains reading SQL from stdin", () => {
  const command = psqlCommand("postgres", "postgres");
  if (!command.includes("podman exec -i 'postgres' psql -U postgres")) {
    throw new Error("unexpected psql invocation shape");
  }
  // No shell operators: the command must survive `sudo -n` wrapping.
  if (/[|;&<>]/.test(command)) {
    throw new Error("command contains shell operators");
  }
  // No environment-variable secret transport; it does not survive sudo or
  // transports without SendEnv support.
  if (command.includes("-v ") || command.includes("SWAMP_")) {
    throw new Error("command still references psql variables");
  }
});

Deno.test("SCRAM-SHA-256 verifier matches independent reference vector", async () => {
  // Reference computed with Python hashlib/hmac:
  // PBKDF2-HMAC-SHA-256("secret-value", salt, 4096) per RFC 7677.
  const verifier = await scramSha256Verifier(
    "secret-value",
    new TextEncoder().encode("0123456789abcdef"),
  );
  const expected =
    "SCRAM-SHA-256$4096:MDEyMzQ1Njc4OWFiY2RlZg==$h014DozjojOweHXYFKtMgeZKDavLdGKLXyzSZqzvC1o=:YwUoLNOgDRtWqNcby6IQMHiy7Z6e3h8QN2EqOtcoceI=";
  if (verifier !== expected) {
    throw new Error(`verifier mismatch: ${verifier}`);
  }
});

Deno.test("PostgreSQL boolean parser accepts text and short output", () => {
  if (!parsePgBoolean("true") || !parsePgBoolean("t")) {
    throw new Error("true values were not parsed");
  }
  if (parsePgBoolean("false") || parsePgBoolean("f")) {
    throw new Error("false values were parsed as true");
  }
});
