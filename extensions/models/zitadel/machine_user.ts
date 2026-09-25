// `@holi0317/zitadel/machine-user` — one swamp model instance = one machine
// (service) user (terraform-style resource). Identity: the username.
//
// Lifecycle (repo house style, cf. @holi0317/postgres/role):
//   check   — observe the machine user
//   apply   — create the user if absent, converge declared displayName/description
//   destroy — hard-delete the user (allowDestroy gate)
//
// Human users are out of scope: this model manages MACHINE identities only.
// accessTokenType is applied at creation only — Zitadel cannot change it in
// place; rotate the user (destroy + apply) to change it.

import { z } from "zod";
import {
  ACCESS_TOKEN_TYPE,
  call,
  findMachineUserByUsername,
  friendlyState,
  type Json,
  logInfo,
  mapEnum,
  mgmt,
  MODEL_VERSION,
  nowIso,
  reachableCheck,
  writeRunResult,
  type ZitadelMethodContext,
  ZitadelTargetSchema,
} from "./_lib.ts";

const GlobalArgumentsSchema = z.object({
  ...ZitadelTargetSchema.shape,
  username: z.string().min(1).describe(
    "Login name — the resource identity (exact match; created if absent)",
  ),
  displayName: z.string().optional().describe(
    "Display name of the service user. Omitted: keeps the current value.",
  ),
  description: z.string().optional().describe(
    "Optional description. Omit to leave the current value as-is.",
  ),
  accessTokenType: z.enum(["bearer", "jwt"]).default("bearer").describe(
    "Access token type — applied at creation only; Zitadel cannot change it " +
      "in place.",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type Ctx = ZitadelMethodContext<GlobalArguments>;

const UserStateSchema = z.object({
  exists: z.boolean(),
  userId: z.string().optional(),
  username: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  state: z.string().optional(),
  observedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  username: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const CheckArgsSchema = z.object({});
const ApplyArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit deleting the machine user",
  ),
});

function writeState(
  context: Ctx,
  ga: GlobalArguments,
  user: Json | null,
) {
  const machine = user === null ? {} : (user.machine ?? {}) as Json;
  return context.writeResource("user", "current", {
    exists: user !== null,
    username: ga.username,
    ...(user === null ? {} : {
      userId: String(user.id ?? user.userId ?? ""),
      displayName: typeof machine.name === "string" ? machine.name : undefined,
      description: typeof machine.description === "string"
        ? machine.description
        : undefined,
      state: friendlyState(user.state),
    }),
    observedAt: nowIso(),
  });
}

export const model = {
  type: "@holi0317/zitadel/machine-user",
  version: MODEL_VERSION,
  globalArguments: GlobalArgumentsSchema,
  checks: {
    reachable: reachableCheck(),
  },
  resources: {
    user: {
      description: "Observed machine user state",
      schema: UserStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a machine-user method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe the machine user",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const user = await findMachineUserByUsername(ga, ga.username);
        const stateHandle = await writeState(context, ga, user);
        const resultHandle = await writeRunResult(
          context,
          "check",
          false,
          { username: ga.username },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description:
        "Create the machine user if absent, then converge the declared " +
        "displayName/description",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const existing = await findMachineUserByUsername(ga, ga.username);
        let changed = false;
        if (!existing) {
          const body: Json = {
            userName: ga.username,
            name: ga.displayName ?? ga.username,
            accessTokenType: mapEnum(
              ACCESS_TOKEN_TYPE,
              ga.accessTokenType,
              "accessTokenType",
            ),
          };
          if (ga.description !== undefined) body.description = ga.description;
          const r = await call(ga, {
            method: "POST",
            path: mgmt("/users/machine"),
            body,
          });
          logInfo(context, "Created machine user", {
            username: ga.username,
            userId: r.body.userId,
          });
          changed = true;
        } else {
          // Converge only DECLARED attributes; omitted ones keep the existing.
          const machine = (existing.machine ?? {}) as Json;
          const displayName = ga.displayName ??
            (typeof machine.name === "string" ? machine.name : ga.username);
          const description = ga.description ??
            (typeof machine.description === "string"
              ? machine.description
              : "");
          const sameName = displayName ===
            (typeof machine.name === "string" ? machine.name : ga.username);
          const sameDescription = description ===
            (typeof machine.description === "string"
              ? machine.description
              : "");
          if (!sameName || !sameDescription) {
            await call(ga, {
              method: "PUT",
              path: mgmt(
                `/users/${
                  encodeURIComponent(String(existing.id ?? existing.userId))
                }/machine`,
              ),
              body: { name: displayName, description },
            });
            logInfo(context, "Updated machine user", { username: ga.username });
            changed = true;
          }
        }
        const user = await findMachineUserByUsername(ga, ga.username);
        const stateHandle = await writeState(context, ga, user);
        const resultHandle = await writeRunResult(
          context,
          "apply",
          changed,
          { username: ga.username },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    destroy: {
      description:
        "Delete the machine user and its credentials; requires allowDestroy=true.",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying machine user ${ga.username} requires allowDestroy=true`,
          );
        }
        const user = await findMachineUserByUsername(ga, ga.username);
        const userId = user
          ? (typeof user.id === "string"
            ? user.id
            : typeof user.userId === "string"
            ? user.userId
            : null)
          : null;
        let changed = false;
        if (userId !== null) {
          await call(ga, {
            method: "DELETE",
            path: mgmt(`/users/${encodeURIComponent(userId)}`),
          });
          logInfo(context, "Deleted machine user", {
            username: ga.username,
            userId,
          });
          changed = true;
        }
        const stateHandle = await writeState(context, ga, null);
        const resultHandle = await writeRunResult(
          context,
          "destroy",
          changed,
          { username: ga.username },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
