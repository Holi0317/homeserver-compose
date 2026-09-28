// `@holi0317/zitadel/oidc-app` — one swamp model instance = one OIDC
// application within a project (terraform-style resource). Identity:
// (project, app name); the Zitadel-assigned app id and clientId are observed
// state.
//
// Lifecycle (repo house style, cf. @holi0317/postgres/role):
//   check   — observe the app's full OIDC config (no secrets)
//   apply   — create the app if absent, converge its OIDC config in place
//             (drift-diffed; a "no changes" rejection from Zitadel is an
//             idempotent no-op)
//   rotate  — regenerate the client secret (emitted ONCE into the `credential`
//             resource)
//   destroy — hard-delete the app (allowDestroy gate)
//
// The client secret is only ever returned by Zitadel at create/rotate time, so
// the `credential` resource is written exactly on those events and never
// rewritten by later applies. Public PKCE clients (authMethod none) have no
// secret at all — consumers bind `clientId` from the `app` resource:
//
//   data.latest("<instance>", "current").attributes.clientId
//
// The referenced project is NEVER created implicitly: a missing project is an
// error pointing at the @holi0317/zitadel/project model.
import { z } from "zod";
import {
  boolArg,
  call,
  desiredOidcWire,
  findAppByName,
  findProjectByName,
  friendlyState,
  type Json,
  jsonArray,
  logInfo,
  looksLikeId,
  mgmt,
  MODEL_VERSION,
  nowIso,
  observedOidcFriendly,
  observedOidcWire,
  oidcDrift,
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
  name: z.string().min(1).describe(
    "Application name — the resource identity within the project",
  ),
  appType: z.enum(["web", "spa", "native"]).default("web"),
  authMethod: z.enum(["basic", "post", "none", "jwt"]).default("basic")
    .describe(
      "OIDC client auth method. Use `none` for public PKCE (SPA/native).",
    ),
  redirectUris: jsonArray(z.string()).default([]).describe(
    "Allowed redirect URIs (exact list; converged)",
  ),
  postLogoutUris: jsonArray(z.string()).default([]).describe(
    "Allowed post-logout redirect URIs (exact list; converged)",
  ),
  grantTypes: jsonArray(
    z.enum(["authorization_code", "implicit", "refresh_token", "device_code"]),
  ).default(["authorization_code", "refresh_token"]),
  responseTypes: jsonArray(z.enum(["code", "id_token", "id_token_token"]))
    .default(["code"]),
  accessTokenType: z.enum(["bearer", "jwt"]).default("bearer"),
  idTokenRoleAssertion: boolArg(false).describe(
    "Include project role claims in the ID token (Zitadel app token setting; the SSO plugin reads roles from the ID token)",
  ),
  idTokenUserinfoAssertion: boolArg(false).describe(
    "Include profile/email claims in the ID token (Zitadel app token setting; required by the SSO plugin's Zitadel template)",
  ),
  devMode: boolArg(false).describe(
    "Relax redirect-URI checks (non-https/localhost). Test only.",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type Ctx = ZitadelMethodContext<GlobalArguments>;

const AppStateSchema = z.object({
  exists: z.boolean(),
  project: z.string(),
  projectId: z.string().optional(),
  appId: z.string().optional(),
  name: z.string(),
  clientId: z.string().optional(),
  state: z.string().optional(),
  appType: z.string().optional(),
  authMethod: z.string().optional(),
  accessTokenType: z.string().optional(),
  redirectUris: z.array(z.string()).optional(),
  postLogoutUris: z.array(z.string()).optional(),
  grantTypes: z.array(z.string()).optional(),
  responseTypes: z.array(z.string()).optional(),
  devMode: z.boolean().optional(),
  idTokenRoleAssertion: z.boolean().optional(),
  idTokenUserinfoAssertion: z.boolean().optional(),
  observedAt: z.iso.datetime(),
});

const CredentialSchema = z.object({
  project: z.string(),
  projectId: z.string(),
  appId: z.string().optional(),
  name: z.string(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional().meta({ sensitive: true }),
  kind: z.literal("oidc"),
  action: z.string(),
  timestamp: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  project: z.string(),
  name: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const CheckArgsSchema = z.object({});
const ApplyArgsSchema = z.object({});
const RotateArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit deleting the application",
  ),
});

function writeState(
  context: Ctx,
  ga: GlobalArguments,
  projectId: string | null,
  app: Json | null,
) {
  const oidc = app === null ? {} : (app.oidcConfig ?? {}) as Json;
  return context.writeResource("app", "current", {
    exists: app !== null,
    project: ga.project,
    name: ga.name,
    ...(projectId === null ? {} : { projectId }),
    ...(app === null ? {} : {
      appId: String(app.id ?? ""),
      clientId: typeof oidc.clientId === "string" ? oidc.clientId : undefined,
      state: friendlyState(app.state),
      ...observedOidcFriendly(oidc),
    }),
    observedAt: nowIso(),
  });
}
async function getApp(
  g: GlobalArguments,
  projectId: string,
  appId: string,
): Promise<Json> {
  const r = await call(g, {
    method: "GET",
    path: mgmt(
      `/projects/${encodeURIComponent(projectId)}/apps/${
        encodeURIComponent(appId)
      }`,
    ),
  });
  return (r.body.app ?? {}) as Json;
}

export const model = {
  type: "@holi0317/zitadel/oidc-app",
  version: MODEL_VERSION,
  globalArguments: GlobalArgumentsSchema,
  checks: {
    reachable: reachableCheck(),
  },
  resources: {
    app: {
      description: "Observed OIDC application state (no secrets)",
      schema: AppStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    credential: {
      description:
        "Client credential — clientId plus the client secret exactly once " +
        "(on create/rotate)",
      schema: CredentialSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of an OIDC app method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe the app's full OIDC config (no secrets)",
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
        const app = projectId === null
          ? null
          : await findAppByName(ga, projectId, ga.name);
        const stateHandle = await writeState(context, ga, projectId, app);
        const resultHandle = await writeRunResult(
          context,
          "check",
          false,
          { project: ga.project, name: ga.name },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description:
        "Create the app if absent, then converge its OIDC config (drift-diffed)",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const projectId = await resolveProjectId(ga, ga.project);
        const cfg = desiredOidcWire(ga);
        const existing = await findAppByName(ga, projectId, ga.name);
        let changed = false;
        let appId: string;

        if (!existing || typeof existing.id !== "string") {
          const r = await call(ga, {
            method: "POST",
            path: mgmt(
              `/projects/${encodeURIComponent(projectId)}/apps/oidc`,
            ),
            body: { name: ga.name, ...cfg },
          });
          appId = String(r.body.appId ?? "");
          logInfo(context, "Created OIDC app", { name: ga.name, appId });
          changed = true;
          // Secret is returned exactly once — persist it in the credential
          // resource now; later applies never rewrite this artifact.
          await context.writeResource("credential", "credential", {
            project: ga.project,
            projectId,
            appId,
            name: ga.name,
            clientId: typeof r.body.clientId === "string"
              ? r.body.clientId
              : undefined,
            clientSecret: typeof r.body.clientSecret === "string"
              ? r.body.clientSecret
              : undefined,
            kind: "oidc",
            action: "created",
            timestamp: nowIso(),
          });
        } else {
          appId = existing.id;
          const drifted = oidcDrift(
            cfg,
            observedOidcWire((existing.oidcConfig ?? {}) as Json),
          );
          if (drifted.length > 0) {
            let action = "updated";
            try {
              await call(ga, {
                method: "PUT",
                path: mgmt(
                  `/projects/${encodeURIComponent(projectId)}/apps/${
                    encodeURIComponent(appId)
                  }/oidc_config`,
                ),
                body: cfg,
              });
              logInfo(context, "Converged OIDC app", {
                name: ga.name,
                appId,
                drifted,
              });
            } catch (e) {
              // Zitadel returns 400 "No changes" when the config already
              // matches — an idempotent no-op, not a failure.
              if (!/no changes/i.test((e as Error).message)) throw e;
              action = "unchanged";
            }
            changed = action === "updated";
          }
        }

        const app = await getApp(ga, projectId, appId);
        const stateHandle = await writeState(context, ga, projectId, app);
        const resultHandle = await writeRunResult(
          context,
          "apply",
          changed,
          { project: ga.project, name: ga.name },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    rotate: {
      description:
        "Regenerate the client secret (verify-first). The new secret is " +
        "written to the credential resource exactly once.",
      arguments: RotateArgsSchema,
      execute: async (
        _args: z.infer<typeof RotateArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const projectId = await resolveProjectId(ga, ga.project);
        const existing = await findAppByName(ga, projectId, ga.name);
        if (!existing || typeof existing.id !== "string") {
          throw new Error(
            `No OIDC app ${
              JSON.stringify(ga.name)
            } in project ${ga.project}; ` +
              `apply the model first`,
          );
        }
        const r = await call(ga, {
          method: "POST",
          path: mgmt(
            `/projects/${encodeURIComponent(projectId)}/apps/${
              encodeURIComponent(existing.id)
            }/oidc_config/_generate_client_secret`,
          ),
          body: {},
        });
        logInfo(context, "Rotated OIDC client secret", {
          name: ga.name,
          appId: existing.id,
        });
        const credentialHandle = await context.writeResource(
          "credential",
          "credential",
          {
            project: ga.project,
            projectId,
            appId: existing.id,
            name: ga.name,
            clientId: typeof r.body.clientId === "string"
              ? r.body.clientId
              : undefined,
            clientSecret: typeof r.body.clientSecret === "string"
              ? r.body.clientSecret
              : undefined,
            kind: "oidc",
            action: "rotated",
            timestamp: nowIso(),
          },
        );
        const app = await getApp(ga, projectId, existing.id);
        const stateHandle = await writeState(context, ga, projectId, app);
        const resultHandle = await writeRunResult(
          context,
          "rotate",
          true,
          { project: ga.project, name: ga.name },
        );
        return { dataHandles: [stateHandle, credentialHandle, resultHandle] };
      },
    },
    destroy: {
      description: "Delete the application; requires allowDestroy=true.",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying Zitadel OIDC app ${ga.name} in project ${ga.project} ` +
              `requires allowDestroy=true`,
          );
        }
        const projectId = looksLikeId(ga.project)
          ? ga.project
          : (await findProjectByName(ga, ga.project))?.id;
        let changed = false;
        if (typeof projectId === "string") {
          const app = await findAppByName(ga, projectId, ga.name);
          if (app && typeof app.id === "string") {
            await call(ga, {
              method: "DELETE",
              path: mgmt(
                `/projects/${encodeURIComponent(projectId)}/apps/${
                  encodeURIComponent(app.id)
                }`,
              ),
            });
            logInfo(context, "Deleted OIDC app", {
              name: ga.name,
              appId: app.id,
            });
            changed = true;
          }
        }
        const stateHandle = await writeState(
          context,
          ga,
          typeof projectId === "string" ? projectId : null,
          null,
        );
        const resultHandle = await writeRunResult(
          context,
          "destroy",
          changed,
          { project: ga.project, name: ga.name },
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
