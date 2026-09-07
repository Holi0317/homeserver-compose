import {
  aclSetUserDirectives,
  parseAclList,
  parseAclRule,
  sha256Hex,
  VALKEY_SOCKET,
  valkeyCliCommand,
} from "./_lib.ts";

Deno.test("sha256Hex matches an independent reference vector", async () => {
  const digest = await sha256Hex("secret-value");
  if (
    digest !==
      "31160254d1297393d2ad00e1c01851aec834361e02c524b89fe06aff2879ce6a"
  ) {
    throw new Error(`sha256 digest mismatch: ${digest}`);
  }
});

Deno.test("ACL LIST output parses into structural user state", () => {
  const output = [
    "user default on #abc123 ~* &* +@all",
    "user nextcloud on #def456 ~nextcloud:* &* +@all",
    "user limited off nopass ~app:* &events +@read -@dangerous (GET)",
  ].join("\n");

  const def = parseAclList(output, "default");
  if (def === null) throw new Error("default user was not found");
  if (!def.on || def.nopass) throw new Error("default flags parsed wrongly");
  if (JSON.stringify(def.passwordHashes) !== '["abc123"]') {
    throw new Error(`password hashes parsed wrongly: ${def.passwordHashes}`);
  }
  if (JSON.stringify(def.keys) !== '["~*"]') {
    throw new Error(`keys parsed wrongly: ${def.keys}`);
  }
  if (JSON.stringify(def.channels) !== '["&*"]') {
    throw new Error(`channels parsed wrongly: ${def.channels}`);
  }
  if (JSON.stringify(def.commands) !== '["+@all"]') {
    throw new Error(`commands parsed wrongly: ${def.commands}`);
  }

  const limited = parseAclList(output, "limited");
  if (limited === null) throw new Error("limited user was not found");
  if (limited.on || !limited.nopass) {
    throw new Error("limited flags parsed wrongly");
  }
  if (limited.passwordHashes.length !== 0) {
    throw new Error("nopass user should have no password hashes");
  }
  if (JSON.stringify(limited.keys) !== '["~app:*"]') {
    throw new Error(`keys parsed wrongly: ${limited.keys}`);
  }
  if (JSON.stringify(limited.channels) !== '["&events"]') {
    throw new Error(`channels parsed wrongly: ${limited.channels}`);
  }
  if (JSON.stringify(limited.commands) !== '["+@read","-@dangerous"]') {
    throw new Error(`commands parsed wrongly: ${limited.commands}`);
  }
  if (JSON.stringify(limited.selectors) !== '["(GET)"]') {
    throw new Error(`selectors parsed wrongly: ${limited.selectors}`);
  }

  if (parseAclList(output, "missing") !== null) {
    throw new Error("missing user should not parse");
  }
});

Deno.test("parseAclRule rejects lines describing another user", () => {
  try {
    parseAclRule("other", "user default on ~*");
    throw new Error("expected parse to fail");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("other")) {
      throw error;
    }
  }
});

Deno.test("new users get full desired rules without reset directives", () => {
  const directives = aclSetUserDirectives({
    on: true,
    passwordHash: "abc123",
    keys: ["~*"],
    channels: ["&*"],
    commands: ["+@all"],
  }, null);
  if (JSON.stringify(directives) !== '["on","#abc123","~*","&*","+@all"]') {
    throw new Error(`unexpected create directives: ${directives}`);
  }
});

Deno.test("converged users produce no directives", () => {
  const observed = parseAclRule("app", "user app on #abc123 ~app:* &* +@all");
  const directives = aclSetUserDirectives({
    on: true,
    passwordHash: "abc123",
    keys: ["~app:*"],
    channels: ["&*"],
    commands: ["+@all"],
  }, observed);
  if (directives.length !== 0) {
    throw new Error(`converged user produced directives: ${directives}`);
  }
});

Deno.test("password rotation clears stale hashes", () => {
  const observed = parseAclRule(
    "app",
    "user app on #oldhash #extrahash ~* &* +@all",
  );
  const rotated =
    "bf7af7dd7140b807f92ddf506348a8dfcba03c4325d2a8d4aafc75c2ae8ae013";
  const directives = aclSetUserDirectives({
    on: true,
    passwordHash: rotated,
    keys: ["~*"],
    channels: ["&*"],
    commands: ["+@all"],
  }, observed);
  if (JSON.stringify(directives) !== `["resetpass","#${rotated}"]`) {
    throw new Error(`unexpected rotation directives: ${directives}`);
  }
});

Deno.test("flag and rule drift converges with targeted directives", () => {
  const observed = parseAclRule(
    "app",
    "user app off nopass ~other:* -@all",
  );
  const directives = aclSetUserDirectives({
    on: true,
    passwordHash: null,
    keys: ["~app:*"],
    channels: ["&events"],
    commands: ["+@read"],
  }, observed);
  const expected = [
    "on",
    "resetkeys",
    "~app:*",
    "resetchannels",
    "&events",
    "-@all",
    "+@read",
  ];
  if (JSON.stringify(directives) !== JSON.stringify(expected)) {
    throw new Error(`unexpected drift directives: ${directives}`);
  }
});

Deno.test("selector drift is cleared", () => {
  const observed = parseAclRule(
    "app",
    "user app on ~* &* +@all (GET)",
  );
  const directives = aclSetUserDirectives({
    on: true,
    passwordHash: null,
    keys: ["~*"],
    channels: ["&*"],
    commands: ["+@all"],
  }, observed);
  if (
    JSON.stringify(directives) !== '["resetpass","nopass","clearselectors"]'
  ) {
    throw new Error(`unexpected selector directives: ${directives}`);
  }
});

Deno.test("valkey-cli commands are argv chains over the local socket", () => {
  const command = valkeyCliCommand("valkey", "adm!n", [
    "ACL",
    "SETUSER",
    "nextcloud",
    "on",
    "#abc123",
  ]);
  // No shell operators: the command must survive `sudo -n` wrapping.
  if (/[|;&<>`]/.test(command)) {
    throw new Error("command contains shell operators");
  }
  if (!command.startsWith("podman exec 'valkey' valkey-cli")) {
    throw new Error(`unexpected invocation shape: ${command}`);
  }
  if (!command.includes(`-s '${VALKEY_SOCKET}'`)) {
    throw new Error("command does not use the management socket");
  }
  if (!command.includes("'adm!n'")) {
    throw new Error("credentials are not passed as a quoted argv word");
  }
});
