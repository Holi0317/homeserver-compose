import {
  parsePgBoolean,
  pgIdent,
  pgLiteral,
  psqlCommand,
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

Deno.test("psql commands reference secret environment variables", () => {
  const command = psqlCommand(
    "postgres",
    "postgres",
    "ALTER ROLE \"nextcloud\" PASSWORD :'role_password';",
    { variables: ["role_password"] },
  );
  if (!command.includes('"$SWAMP_ROLE_PASSWORD"')) {
    throw new Error("password environment variable is not referenced");
  }
  if (command.includes("secret-value")) {
    throw new Error("secret value leaked into command text");
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
