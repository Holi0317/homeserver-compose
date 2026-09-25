// `@holi0317/zitadel/machine-key` — one swamp model instance = one JSON
// machine key of a machine user (terraform-style resource, cf. terraform's
// `zitadel_machine_key`). Identity: the model instance itself, which tracks
// its key id in the `key` resource.
//
// Lifecycle (repo house style, cf. @holi0317/postgres/role):
//   check   — observe whether the tracked key still exists on the user
//   apply   — create a new key only when the tracked key is absent (the
//             private key JSON is emitted ONCE into the `credential` resource)
//   destroy — delete the tracked key (allowDestroy gate)
//
// Zitadel shows a machine key's private key exactly once and offers no
// converge — so apply is create-once: to rotate, destroy then apply (or
// destroy and let the next apply mint a fresh key). Losing the instance's
// `key` resource (state) counts as drift: the next apply mints a replacement.

import { z } from "zod";
import {
  call,
  type Json,
  logInfo,
  mgmt,
  MODEL_VERSION,
  nowIso,
  reachableCheck,
  resolveUserId,
  searchAll,
  writeRunResult,
  type ZitadelMethodContext,
  ZitadelTargetSchema,
} from "./_lib.ts";

const GlobalArgumentsSchema = z.object({
  ...ZitadelTargetSchema.shape,
  user: z.string().describe(
    "Machine user id or username; must already exist",
  ),
  expirationDate: z.string().optional().describe(
    "RFC3339 expiry for newly minted keys, e.g. 2027-01-01T00:00:00Z (omit for none)",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type Ctx = ZitadelMethodContext<GlobalArguments>;

const KeyStateSchema = z.object({
  exists: z.boolean(),
  user: z.string(),
  userId: z.string().optional(),
  keyId: z.string().optional(),
  expirationDate: z.string().optional(),
  observedAt: z.iso.datetime(),
});

const CredentialSchema = z.object({
  user: z.string(),
  userId: z.string().optional(),
  keyId: z.string().optional(),
  keyDetails: z.string().optional().meta({ sensitive: true }),
  expirationDate: z.string().optional(),
  action: z.string(),
  timestamp: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  user: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const CheckArgsSchema = z.object({});
const ApplyArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit deleting the tracked machine key",
  ),
});

interface KeyRow {
  id: string;
  expirationDate?: string;
}

/** List a user's machine keys; tolerates either id/keyId and date field spellings. */
async function listKeys(
  g: GlobalArguments,
  userId: string,
): Promise<KeyRow[]> {
  const rows = await searchAll(
    g,
    mgmt(`/users/${encodeURIComponent(userId)}/keys/_search`),
  );
  return rows.map((k) => ({
    id: String(k.id ?? k.keyId ?? ""),
    expirationDate: typeof k.expirationDate === "string"
      ? k.expirationDate
      : typeof k.expiryDate === "string"
      ? k.expiryDate
      : undefined,
  }));
}

function writeState(
  context: Ctx,
  ga: GlobalArguments,
  userId: string | null,
  tracked: KeyRow | null,
) {
  return context.writeResource("key", "current", {
    exists: tracked !== null,
    user: ga.user,
    ...(userId === null ? {} : { userId }),
    ...(tracked === null ? {} : {
      keyId: tracked.id,
      expirationDate: tracked.expirationDate,
    }),
    observedAt: nowIso(),
  });
}

/** Decode the base64 keyDetails blob into the storable JSON string. */
function decodeKeyDetails(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const bin = atob(raw);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return raw;
  }
}

export const model = {
  type: "@holi0317/zitadel/machine-key",
  version: MODEL_VERSION,
  globalArguments: GlobalArgumentsSchema,
  checks: {
    reachable: reachableCheck(),
  },
  resources: {
    key: {
      description: "Observed state of the tracked machine key",
      schema: KeyStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    credential: {
      description:
        "Minted credential — the private key JSON exactly once, at creation",
      schema: CredentialSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a machine-key method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe whether the tracked key still exists on the user",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        let userId: string | null = null;
        try {
          userId = await resolveUserId(ga, ga.user);
        } catch {
          // A missing user is observed state here, not an apply-time error.
          userId = null;
        }
        const keys = userId === null ? [] : await listKeys(ga, userId);
        const prior = await context.readResource("current");
        const trackedId = typeof prior?.keyId === "string" ? prior.keyId : null;
        const tracked = trackedId === null
          ? null
          : keys.find((k) => k.id === trackedId) ?? null;
        const stateHandle = await writeState(
          context,
          ga,
          userId,
          tracked,
        );
        const resultHandle = await writeRunResult(
          context,
          "check",
          false,
          { user: ga.user },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description:
        "Mint a new key only when the tracked key is absent; the private key " +
        "JSON is emitted once into the credential resource",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const userId = await resolveUserId(ga, ga.user);
        const keys = await listKeys(ga, userId);
        const prior = await context.readResource("current");
        const trackedId = typeof prior?.keyId === "string" ? prior.keyId : null;
        const tracked = trackedId === null
          ? null
          : keys.find((k) => k.id === trackedId) ?? null;

        if (tracked !== null) {
          const stateHandle = await writeState(context, ga, userId, tracked);
          const resultHandle = await writeRunResult(
            context,
            "apply",
            false,
            { user: ga.user },
          );
          return { dataHandles: [stateHandle, resultHandle] };
        }

        const body: Json = { type: "KEY_TYPE_JSON" };
        if (ga.expirationDate !== undefined) {
          body.expirationDate = ga.expirationDate;
        }
        const r = await call(ga, {
          method: "POST",
          path: mgmt(`/users/${encodeURIComponent(userId)}/keys`),
          body,
        });
        logInfo(context, "Created machine key", {
          user: ga.user,
          keyId: r.body.keyId,
        });
        // The private key JSON is returned exactly once — persist it in the
        // credential resource now; later applies never rewrite this artifact.
        const credentialHandle = await context.writeResource(
          "credential",
          "credential",
          {
            user: ga.user,
            userId,
            keyId: typeof r.body.keyId === "string" ? r.body.keyId : undefined,
            keyDetails: decodeKeyDetails(r.body.keyDetails),
            expirationDate: ga.expirationDate,
            action: "created",
            timestamp: nowIso(),
          },
        );
        const freshKeys = await listKeys(ga, userId);
        const freshId = typeof r.body.keyId === "string" ? r.body.keyId : null;
        const trackedNow = freshId === null
          ? null
          : freshKeys.find((k) => k.id === freshId) ?? null;
        const stateHandle = await writeState(
          context,
          ga,
          userId,
          trackedNow ??
            { id: freshId ?? "", expirationDate: ga.expirationDate },
        );
        const resultHandle = await writeRunResult(
          context,
          "apply",
          true,
          { user: ga.user },
        );
        return { dataHandles: [stateHandle, credentialHandle, resultHandle] };
      },
    },
    destroy: {
      description:
        "Delete the tracked machine key; requires allowDestroy=true.",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying the tracked machine key of ${ga.user} requires ` +
              `allowDestroy=true`,
          );
        }
        const userId = await resolveUserId(ga, ga.user);
        const keys = await listKeys(ga, userId);
        const prior = await context.readResource("current");
        const trackedId = typeof prior?.keyId === "string" ? prior.keyId : null;
        let changed = false;
        if (trackedId !== null && keys.some((k) => k.id === trackedId)) {
          await call(ga, {
            method: "DELETE",
            path: mgmt(
              `/users/${encodeURIComponent(userId)}/keys/${
                encodeURIComponent(trackedId)
              }`,
            ),
          });
          logInfo(context, "Deleted machine key", {
            user: ga.user,
            keyId: trackedId,
          });
          changed = true;
        }
        const stateHandle = await writeState(context, ga, userId, null);
        const resultHandle = await writeRunResult(
          context,
          "destroy",
          changed,
          { user: ga.user },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
