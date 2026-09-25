// `@holi0317/zitadel/project` — one swamp model instance = one Zitadel project
// (terraform-style resource). The project NAME is the natural identity; the
// Zitadel-assigned numeric id is observed state.
//
// Lifecycle (repo house style, cf. @holi0317/postgres/role):
//   check   — observe the project and its authorization flags
//   apply   — create the project if absent, converge the authz flags
//   destroy — hard-delete the project (allowDestroy gate; cascades its apps,
//             roles, and grants)
//
// Authz flags (roleAssertion / roleCheck / hasProjectCheck) are project
// attributes in Zitadel, so the old `project_authz_set` verb folds in here:
// a declared flag converges; an omitted flag is left as-is.

import { z } from "zod";
import {
  call,
  findProjectByName,
  friendlyState,
  type Json,
  logInfo,
  looksLikeId,
  mgmt,
  MODEL_VERSION,
  nowIso,
  optBoolArg,
  reachableCheck,
  writeRunResult,
  type ZitadelMethodContext,
  type ZitadelTarget,
  ZitadelTargetSchema,
} from "./_lib.ts";

const GlobalArgumentsSchema = z.object({
  ...ZitadelTargetSchema.shape,
  name: z.string().min(1).describe(
    "Project name — the resource identity (exact match; created if absent)",
  ),
  roleAssertion: optBoolArg().describe(
    "Assert project roles into tokens/userinfo (the flag that surfaces grants). " +
      "Omit to leave the current value as-is.",
  ),
  roleCheck: optBoolArg().describe(
    "Require a project role to authenticate. Omit to leave the current value as-is.",
  ),
  hasProjectCheck: optBoolArg().describe(
    "Require the user's org to have the project granted. Omit to leave as-is.",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type Ctx = ZitadelMethodContext<GlobalArguments>;

const ProjectStateSchema = z.object({
  exists: z.boolean(),
  id: z.string().optional(),
  name: z.string(),
  state: z.string().optional(),
  roleAssertion: z.boolean().optional(),
  roleCheck: z.boolean().optional(),
  hasProjectCheck: z.boolean().optional(),
  observedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  name: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const CheckArgsSchema = z.object({});
const ApplyArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit deleting the project. Zitadel cascades the delete to the " +
      "project's applications, roles, and user grants.",
  ),
});

function writeState(
  context: Ctx,
  ga: GlobalArguments,
  project: Json | null,
) {
  return context.writeResource("project", "current", {
    exists: project !== null,
    name: ga.name,
    ...(project === null ? {} : {
      id: String(project.id ?? ""),
      state: friendlyState(project.state),
      roleAssertion: typeof project.projectRoleAssertion === "boolean"
        ? project.projectRoleAssertion
        : undefined,
      roleCheck: typeof project.projectRoleCheck === "boolean"
        ? project.projectRoleCheck
        : undefined,
      hasProjectCheck: typeof project.hasProjectCheck === "boolean"
        ? project.hasProjectCheck
        : undefined,
    }),
    observedAt: nowIso(),
  });
}

/** Fetch the full project record by id (search results may omit PUT-relevant fields). */
async function getProject(
  g: ZitadelTarget,
  projectId: string,
): Promise<Json> {
  const r = await call(g, {
    method: "GET",
    path: mgmt(`/projects/${encodeURIComponent(projectId)}`),
  });
  return (r.body.project ?? {}) as Json;
}

export const model = {
  type: "@holi0317/zitadel/project",
  version: MODEL_VERSION,
  globalArguments: GlobalArgumentsSchema,
  checks: {
    reachable: reachableCheck(),
  },
  resources: {
    project: {
      description: "Observed project state and authorization flags",
      schema: ProjectStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a project method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe the project and its authorization flags",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const project = await findProjectByName(ga, ga.name);
        const stateHandle = await writeState(context, ga, project);
        const resultHandle = await writeRunResult(
          context,
          "check",
          false,
          { name: ga.name },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description:
        "Create the project if absent, then converge the declared authorization flags",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        let changed = false;
        const found = await findProjectByName(ga, ga.name);
        let project: Json;
        if (!found || typeof found.id !== "string") {
          const r = await call(ga, {
            method: "POST",
            path: mgmt("/projects"),
            body: { name: ga.name },
          });
          logInfo(context, "Created project", {
            name: ga.name,
            id: r.body.id,
          });
          changed = true;
          project = await getProject(ga, String(r.body.id ?? ""));
        } else {
          project = await getProject(ga, found.id);
        }

        // Converge only DECLARED flags; omitted flags keep their observed value.
        const current = {
          roleAssertion: project.projectRoleAssertion === true,
          roleCheck: project.projectRoleCheck === true,
          hasProjectCheck: project.hasProjectCheck === true,
        };
        const want = {
          roleAssertion: ga.roleAssertion ?? current.roleAssertion,
          roleCheck: ga.roleCheck ?? current.roleCheck,
          hasProjectCheck: ga.hasProjectCheck ?? current.hasProjectCheck,
        };
        if (
          want.roleAssertion !== current.roleAssertion ||
          want.roleCheck !== current.roleCheck ||
          want.hasProjectCheck !== current.hasProjectCheck
        ) {
          await call(ga, {
            method: "PUT",
            path: mgmt(`/projects/${encodeURIComponent(String(project.id))}`),
            body: {
              name: String(project.name ?? ga.name),
              projectRoleAssertion: want.roleAssertion,
              projectRoleCheck: want.roleCheck,
              hasProjectCheck: want.hasProjectCheck,
              privateLabelingSetting: typeof project.privateLabelingSetting ===
                  "string"
                ? project.privateLabelingSetting
                : "PRIVATE_LABELING_SETTING_UNSPECIFIED",
            },
          });
          logInfo(context, "Converged project authz flags", {
            name: ga.name,
            ...want,
          });
          changed = true;
          project = await getProject(ga, String(project.id));
        }

        const stateHandle = await writeState(context, ga, project);
        const resultHandle = await writeRunResult(
          context,
          "apply",
          changed,
          { name: ga.name },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    destroy: {
      description:
        "Delete the project. Zitadel cascades the delete to its applications, " +
        "roles, and user grants; requires allowDestroy=true.",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying Zitadel project ${ga.name} requires allowDestroy=true`,
          );
        }
        const found = looksLikeId(ga.name)
          ? await getProject(ga, ga.name).catch(() => null)
          : await findProjectByName(ga, ga.name);
        const projectId = found && typeof found.id === "string"
          ? found.id
          : null;
        if (projectId !== null) {
          await call(ga, {
            method: "DELETE",
            path: mgmt(`/projects/${encodeURIComponent(projectId)}`),
          });
          logInfo(context, "Deleted project", { name: ga.name });
        }
        const stateHandle = await writeState(context, ga, null);
        const resultHandle = await writeRunResult(
          context,
          "destroy",
          projectId !== null,
          { name: ga.name },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
