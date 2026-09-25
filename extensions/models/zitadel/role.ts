// `@holi0317/zitadel/role` — one swamp model instance = one project role
// (terraform-style resource). Identity: (project, role key).
//
// Lifecycle (repo house style, cf. @holi0317/postgres/role):
//   check   — observe the role within its project
//   apply   — create the role if absent, converge declared displayName/group
//   destroy — hard-delete the role (allowDestroy gate; Zitadel cascade-revokes
//             any user grants referencing it)
//
// The referenced project is NEVER created implicitly: a missing project is an
// error pointing at the @holi0317/zitadel/project model.

import { z } from "zod";
import {
  call,
  findProjectByName,
  findRoleByKey,
  type Json,
  logInfo,
  looksLikeId,
  mgmt,
  MODEL_VERSION,
  nowIso,
  reachableCheck,
  resolveProjectId,
  writeRunResult,
  type ZitadelMethodContext,
  ZitadelTargetSchema,
} from "./_lib.ts";

const GlobalArgumentsSchema = z.object({
  ...ZitadelTargetSchema.shape,
  project: z.string().describe(
    "Project name (exact match) or numeric project id; must already exist",
  ),
  key: z.string().min(1).describe(
    "Role key — the resource identity within the project",
  ),
  displayName: z.string().optional().describe(
    "Human-readable role name. Omitted: keeps the current value (defaults to " +
      "the key on create).",
  ),
  group: z.string().optional().describe(
    "Optional grouping label. Omit to leave the current value as-is.",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type Ctx = ZitadelMethodContext<GlobalArguments>;

const RoleStateSchema = z.object({
  exists: z.boolean(),
  project: z.string(),
  projectId: z.string().optional(),
  key: z.string(),
  displayName: z.string().optional(),
  group: z.string().optional(),
  observedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  project: z.string(),
  key: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const CheckArgsSchema = z.object({});
const ApplyArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit deleting the role; Zitadel cascade-revokes user grants that " +
      "reference it.",
  ),
});

function writeState(
  context: Ctx,
  ga: GlobalArguments,
  projectId: string | null,
  role: Json | null,
) {
  return context.writeResource("role", "current", {
    exists: role !== null,
    project: ga.project,
    ...(projectId === null ? {} : { projectId }),
    key: ga.key,
    ...(role === null ? {} : {
      displayName: typeof role.displayName === "string"
        ? role.displayName
        : undefined,
      group: typeof role.group === "string" ? role.group : undefined,
    }),
    observedAt: nowIso(),
  });
}

export const model = {
  type: "@holi0317/zitadel/role",
  version: MODEL_VERSION,
  globalArguments: GlobalArgumentsSchema,
  checks: {
    reachable: reachableCheck(),
  },
  resources: {
    role: {
      description: "Observed project role state",
      schema: RoleStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a role method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe the role within its project",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const project = looksLikeId(ga.project)
          ? null
          : await findProjectByName(ga, ga.project);
        const projectId = looksLikeId(ga.project)
          ? ga.project
          : project && typeof project.id === "string"
          ? project.id
          : null;
        const role = projectId === null
          ? null
          : await findRoleByKey(ga, projectId, ga.key);
        const stateHandle = await writeState(context, ga, projectId, role);
        const resultHandle = await writeRunResult(
          context,
          "check",
          false,
          { project: ga.project, key: ga.key },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description:
        "Create the role if absent, then converge the declared displayName/group",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const projectId = await resolveProjectId(ga, ga.project);
        const existing = await findRoleByKey(ga, projectId, ga.key);
        let changed = false;
        if (!existing) {
          const body: Json = {
            roleKey: ga.key,
            displayName: ga.displayName ?? ga.key,
          };
          if (ga.group !== undefined) body.group = ga.group;
          await call(ga, {
            method: "POST",
            path: mgmt(`/projects/${encodeURIComponent(projectId)}/roles`),
            body,
          });
          logInfo(context, "Created role", { projectId, key: ga.key });
          changed = true;
        } else {
          // Converge only DECLARED attributes; omitted ones keep the existing.
          const displayName = ga.displayName ??
            (typeof existing.displayName === "string"
              ? existing.displayName
              : ga.key);
          const group = ga.group ??
            (typeof existing.group === "string" ? existing.group : "");
          const sameName = displayName ===
            (typeof existing.displayName === "string"
              ? existing.displayName
              : ga.key);
          const sameGroup = group ===
            (typeof existing.group === "string" ? existing.group : "");
          if (!sameName || !sameGroup) {
            await call(ga, {
              method: "PUT",
              path: mgmt(
                `/projects/${encodeURIComponent(projectId)}/roles/${
                  encodeURIComponent(ga.key)
                }`,
              ),
              body: { displayName, group },
            });
            logInfo(context, "Updated role", { projectId, key: ga.key });
            changed = true;
          }
        }
        const role = await findRoleByKey(ga, projectId, ga.key);
        const stateHandle = await writeState(context, ga, projectId, role);
        const resultHandle = await writeRunResult(
          context,
          "apply",
          changed,
          { project: ga.project, key: ga.key },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    destroy: {
      description:
        "Delete the role. Zitadel cascade-revokes user grants referencing it; " +
        "requires allowDestroy=true.",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying Zitadel role ${ga.key} in project ${ga.project} ` +
              `requires allowDestroy=true`,
          );
        }
        const projectId = looksLikeId(ga.project)
          ? ga.project
          : (await findProjectByName(ga, ga.project))?.id;
        const projectIdOrNull = typeof projectId === "string"
          ? projectId
          : null;
        const role = projectIdOrNull === null
          ? null
          : await findRoleByKey(ga, projectIdOrNull, ga.key);
        let changed = false;
        if (role !== null && projectIdOrNull !== null) {
          await call(ga, {
            method: "DELETE",
            path: mgmt(
              `/projects/${encodeURIComponent(projectIdOrNull)}/roles/${
                encodeURIComponent(ga.key)
              }`,
            ),
          });
          logInfo(context, "Deleted role", {
            projectId: projectIdOrNull,
            key: ga.key,
          });
          changed = true;
        }
        const stateHandle = await writeState(
          context,
          ga,
          projectIdOrNull,
          null,
        );
        const resultHandle = await writeRunResult(
          context,
          "destroy",
          changed,
          { project: ga.project, key: ga.key },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
