import { z } from "zod";
import {
  aclSetUserDirectives,
  type AclUser,
  execAcl,
  parseAclList,
  sha256Hex,
  type ValkeyMethodContext,
  ValkeyTargetSchema,
} from "./_lib.ts";

const UserNameSchema = z.string().min(1).max(63).regex(
  /^[A-Za-z0-9_.-]+$/,
  "Usernames must contain only letters, digits, underscores, dots, and dashes",
);

const RuleSchema = z.string().min(1).max(256).regex(
  /^\S+$/,
  "ACL rules must not contain whitespace",
);

const GlobalArgumentsSchema = z.object({
  ...ValkeyTargetSchema.shape,
  userName: UserNameSchema.describe("Valkey ACL username"),
  enabled: z.boolean().default(true).describe(
    "Whether the user may authenticate",
  ),
  keyPatterns: z.array(RuleSchema).default(["~*"]).describe(
    "Key access patterns (`~` globs or `%R~`/`%W~` permissions)",
  ),
  channelPatterns: z.array(RuleSchema).default(["&*"]).describe(
    "Pub/sub channel patterns",
  ),
  commands: z.array(RuleSchema).default(["+@all"]).describe(
    "Command rules (categories such as `+@all` or individual commands)",
  ),
  database: z.number().int().min(0).max(15).optional().describe(
    "Logical database (0-15) this consumer uses. A declared allocation recorded in state for application wiring; the server cannot pin a user to a database.",
  ),
  password: z.string().min(1).optional().describe(
    "Desired password; pass through a vault expression",
  ),
  adminPassword: z.string().min(1).describe(
    "Credential of the default user used for management connections; pass through a vault expression",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type MethodContext = ValkeyMethodContext<GlobalArguments>;

const UserStateSchema = z.object({
  exists: z.boolean(),
  host: z.string(),
  containerName: z.string(),
  userName: z.string(),
  enabled: z.boolean().optional(),
  keyPatterns: z.array(z.string()).optional(),
  channelPatterns: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  passwordMatches: z.boolean().optional(),
  database: z.number().int().optional(),
  observedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  userName: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const ApplyArgsSchema = z.object({});
const CheckArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit deleting the ACL user",
  ),
});

interface DesiredUser {
  on: boolean;
  passwordHash: string | null;
  keys: string[];
  channels: string[];
  commands: string[];
}

async function desiredFromArgs(ga: GlobalArguments): Promise<DesiredUser> {
  return {
    on: ga.enabled,
    passwordHash: ga.password === undefined
      ? null
      : await sha256Hex(ga.password),
    keys: ga.keyPatterns,
    channels: ga.channelPatterns,
    commands: ga.commands,
  };
}

async function inspectUser(
  context: MethodContext,
  ga: GlobalArguments,
): Promise<AclUser | null> {
  const result = await execAcl(context, ga, ga.adminPassword, [
    "ACL",
    "LIST",
  ]);
  return parseAclList(result.stdout, ga.userName);
}

function stateFromUser(
  ga: GlobalArguments,
  user: AclUser | null,
  desired: DesiredUser,
) {
  return {
    exists: user !== null,
    host: ga.host,
    containerName: ga.containerName,
    userName: ga.userName,
    ...(user === null ? {} : {
      enabled: user.on,
      keyPatterns: user.keys,
      channelPatterns: user.channels,
      commands: user.commands,
      ...(desired.passwordHash === null ? {} : {
        passwordMatches: user.passwordHashes.includes(desired.passwordHash),
      }),
    }),
    ...(ga.database === undefined ? {} : { database: ga.database }),
    observedAt: new Date().toISOString(),
  };
}

function writeState(
  context: MethodContext,
  ga: GlobalArguments,
  user: AclUser | null,
  desired: DesiredUser,
): Promise<{ name: string }> {
  return context.writeResource(
    "user",
    "current",
    stateFromUser(ga, user, desired),
  );
}

function writeRunResult(
  context: MethodContext,
  ga: GlobalArguments,
  method: string,
  changed: boolean,
): Promise<{ name: string }> {
  return context.writeResource("runResult", "last", {
    method,
    host: ga.host,
    userName: ga.userName,
    changed,
    success: true,
    timestamp: new Date().toISOString(),
  });
}

export const model = {
  type: "@holi0317/valkey/user",
  version: "2026.09.07.2",
  globalArguments: GlobalArgumentsSchema,
  resources: {
    user: {
      description: "Observed Valkey ACL user state without its password",
      schema: UserStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a Valkey ACL user method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe whether the ACL user matches the shared instance",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const desired = await desiredFromArgs(ga);
        const user = await inspectUser(context, ga);
        const stateHandle = await writeState(context, ga, user, desired);
        const resultHandle = await writeRunResult(context, ga, "check", false);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description: "Create or converge one Valkey ACL user",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const desired = await desiredFromArgs(ga);
        const before = await inspectUser(context, ga);
        const directives = aclSetUserDirectives(desired, before);
        if (directives.length > 0) {
          await execAcl(context, ga, ga.adminPassword, [
            "ACL",
            "SETUSER",
            ga.userName,
            ...directives,
          ]);
          await execAcl(context, ga, ga.adminPassword, ["ACL", "SAVE"]);
        }
        const after = await inspectUser(context, ga);
        if (after === null) {
          throw new Error(
            `Valkey ACL user ${ga.userName} was not found after apply`,
          );
        }
        const remaining = aclSetUserDirectives(desired, after);
        if (remaining.length > 0) {
          throw new Error(
            `Valkey ACL user ${ga.userName} did not converge; remaining drift: ${
              remaining.join(" ")
            }`,
          );
        }
        const stateHandle = await writeState(context, ga, after, desired);
        const resultHandle = await writeRunResult(context, ga, "apply", true);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    destroy: {
      description: "Delete the ACL user from the shared instance",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        if (ga.userName === "default") {
          throw new Error("The default Valkey user cannot be destroyed");
        }
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying Valkey ACL user ${ga.userName} requires allowDestroy=true`,
          );
        }
        await execAcl(context, ga, ga.adminPassword, [
          "ACL",
          "DELUSER",
          ga.userName,
        ]);
        await execAcl(context, ga, ga.adminPassword, ["ACL", "SAVE"]);
        const desired = await desiredFromArgs(ga);
        const stateHandle = await writeState(context, ga, null, desired);
        const resultHandle = await writeRunResult(context, ga, "destroy", true);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
