// `@holi0317/zitadel/grant` — one swamp model instance = one user grant
// (terraform-style resource): which roles a user holds on a project.
// Identity: (user, project); the Zitadel-assigned grant id is observed state.
//
// Lifecycle (repo house style, cf. @holi0317/postgres/role):
//   check   — observe the grant and its role-key set
//   apply   — create the grant if absent, converge roleKeys to the EXACT
//             declared set (a role removed from the list is revoked)
//   destroy — hard-delete the grant (allowDestroy gate)
//
// roleKeys only surface in the user's tokens when the project has
// roleAssertion enabled — declare it on the @holi0317/zitadel/project model.
// The referenced user and project are NEVER created implicitly: a missing
// reference is an error pointing at the owning model.

import { z } from "zod";
import {
  call,
  findGrant,
  findProjectByName,
  friendlyState,
  type Json,
  jsonArray,
  logInfo,
  looksLikeId,
  mgmt,
  MODEL_VERSION,
  nowIso,
  reachableCheck,
  resolveProjectId,
  resolveUserId,
  writeRunResult,
  type ZitadelMethodContext,
  ZitadelTargetSchema,
} from "./_lib.ts";

const GlobalArgumentsSchema = z.object({
  ...ZitadelTargetSchema.shape,
  user: z.string().describe(
    "User id or loginname; must already exist (machine users via the " +
      "machine-user model)",
  ),
  project: z.string().describe(
    "Project name (exact match) or numeric project id; must already exist",
  ),
  roleKeys: jsonArray(z.string()).default([]).describe(
    "The EXACT set of role keys the user should hold on this project (converged)",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type Ctx = ZitadelMethodContext<GlobalArguments>;

const GrantStateSchema = z.object({
  exists: z.boolean(),
  grantId: z.string().optional(),
  user: z.string(),
  userId: z.string().optional(),
  project: z.string(),
  projectId: z.string().optional(),
  roleKeys: z.array(z.string()).optional(),
  state: z.string().optional(),
  observedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  user: z.string(),
  project: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const CheckArgsSchema = z.object({});
const ApplyArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit deleting the grant",
  ),
});

function writeState(
  context: Ctx,
  ga: GlobalArguments,
  userId: string | null,
  projectId: string | null,
  grant: Json | null,
) {
  return context.writeResource("grant", "current", {
    exists: grant !== null,
    user: ga.user,
    project: ga.project,
    ...(userId === null ? {} : { userId }),
    ...(projectId === null ? {} : { projectId }),
    ...(grant === null ? {} : {
      grantId: String(grant.id ?? ""),
      roleKeys: Array.isArray(grant.roleKeys)
        ? (grant.roleKeys as string[])
        : undefined,
      state: friendlyState(grant.state),
    }),
    observedAt: nowIso(),
  });
}

/** Sorted role-key set comparison — the grant converges to an exact set. */
function sameRoleKeys(a: string[], b: string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export const model = {
  type: "@holi0317/zitadel/grant",
  version: MODEL_VERSION,
  globalArguments: GlobalArgumentsSchema,
  checks: {
    reachable: reachableCheck(),
  },
  resources: {
    grant: {
      description: "Observed user grant state",
      schema: GrantStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a grant method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe the grant and its role-key set",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        // check observes: missing user/project refs mean exists:false, not an error.
        const userId = await resolveUserId(ga, ga.user).catch(() => null);
        const projectId = looksLikeId(ga.project)
          ? ga.project
          : userId === null
          ? null
          : (await findProjectByName(ga, ga.project))?.id;
        const grant = typeof projectId === "string" && userId !== null
          ? await findGrant(ga, userId, projectId)
          : null;
        const stateHandle = await writeState(
          context,
          ga,
          userId,
          typeof projectId === "string" ? projectId : null,
          grant,
        );
        const resultHandle = await writeRunResult(
          context,
          "check",
          false,
          { user: ga.user, project: ga.project },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description:
        "Create the grant if absent, then converge roleKeys to the exact set",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const userId = await resolveUserId(ga, ga.user);
        const projectId = await resolveProjectId(ga, ga.project);
        const existing = await findGrant(ga, userId, projectId);
        let changed = false;
        if (!existing || typeof existing.id !== "string") {
          const r = await call(ga, {
            method: "POST",
            path: mgmt(`/users/${encodeURIComponent(userId)}/grants`),
            body: { projectId, roleKeys: ga.roleKeys },
          });
          logInfo(context, "Created grant", {
            userId,
            projectId,
            grantId: r.body.userGrantId ?? r.body.id,
          });
          changed = true;
        } else {
          const current = Array.isArray(existing.roleKeys)
            ? (existing.roleKeys as string[])
            : [];
          if (!sameRoleKeys(current, ga.roleKeys)) {
            await call(ga, {
              method: "PUT",
              path: mgmt(
                `/users/${encodeURIComponent(userId)}/grants/${
                  encodeURIComponent(existing.id)
                }`,
              ),
              body: { roleKeys: ga.roleKeys },
            });
            logInfo(context, "Updated grant", {
              userId,
              projectId,
              grantId: existing.id,
            });
            changed = true;
          }
        }
        const grant = await findGrant(ga, userId, projectId);
        const stateHandle = await writeState(
          context,
          ga,
          userId,
          projectId,
          grant,
        );
        const resultHandle = await writeRunResult(
          context,
          "apply",
          changed,
          { user: ga.user, project: ga.project },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    destroy: {
      description: "Delete the grant; requires allowDestroy=true.",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying the grant of ${ga.user} on project ${ga.project} ` +
              `requires allowDestroy=true`,
          );
        }
        const userId = await resolveUserId(ga, ga.user).catch(() => null);
        const projectId = looksLikeId(ga.project)
          ? ga.project
          : userId === null
          ? null
          : (await findProjectByName(ga, ga.project))?.id;
        const grant = userId !== null && typeof projectId === "string"
          ? await findGrant(ga, userId, projectId)
          : null;
        let changed = false;
        if (grant && typeof grant.id === "string" && userId !== null) {
          await call(ga, {
            method: "DELETE",
            path: mgmt(
              `/users/${encodeURIComponent(userId)}/grants/${
                encodeURIComponent(grant.id)
              }`,
            ),
          });
          logInfo(context, "Deleted grant", {
            userId,
            grantId: grant.id,
          });
          changed = true;
        }
        const stateHandle = await writeState(
          context,
          ga,
          userId,
          typeof projectId === "string" ? projectId : null,
          null,
        );
        const resultHandle = await writeRunResult(
          context,
          "destroy",
          changed,
          { user: ga.user, project: ga.project },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
