import { z } from "npm:zod@4";
import {
  execPsql,
  parsePgBoolean,
  parsePipeRow,
  pgIdent,
  pgLiteral,
  type PostgresMethodContext,
  PostgresTargetSchema,
} from "./_lib.ts";

const RoleNameSchema = z.string().min(1).max(63).regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  "Role names must contain only letters, digits, and underscores",
);

const GlobalArgumentsSchema = z.object({
  ...PostgresTargetSchema.shape,
  roleName: RoleNameSchema.describe("PostgreSQL role name"),
  login: z.boolean().default(true).describe("Whether the role may log in"),
  superuser: z.boolean().optional().describe(
    "If provided, converge SUPERUSER status",
  ),
  createdb: z.boolean().optional().describe(
    "If provided, converge CREATEDB status",
  ),
  createrole: z.boolean().optional().describe(
    "If provided, converge CREATEROLE status",
  ),
  inherit: z.boolean().optional().describe(
    "If provided, converge role membership inheritance",
  ),
  replication: z.boolean().optional().describe(
    "If provided, converge REPLICATION status",
  ),
  bypassRls: z.boolean().optional().describe(
    "If provided, converge BYPASSRLS status",
  ),
  connectionLimit: z.number().int().min(-1).optional().describe(
    "If provided, maximum concurrent connections (-1 means unlimited)",
  ),
  password: z.string().min(1).optional().describe(
    "Desired role password; pass through a vault expression",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type MethodContext = PostgresMethodContext<GlobalArguments>;

const RoleStateSchema = z.object({
  exists: z.boolean(),
  host: z.string(),
  containerName: z.string(),
  roleName: z.string(),
  login: z.boolean().optional(),
  superuser: z.boolean().optional(),
  createdb: z.boolean().optional(),
  createrole: z.boolean().optional(),
  inherit: z.boolean().optional(),
  replication: z.boolean().optional(),
  bypassRls: z.boolean().optional(),
  connectionLimit: z.number().int().optional(),
  observedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  roleName: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const ApplyArgsSchema = z.object({});
const CheckArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit dropping the role; ownership must already be transferred",
  ),
});
const RotatePasswordArgsSchema = z.object({
  newPassword: z.string().min(1).describe(
    "New password; pass through a vault expression",
  ),
});

type RoleRow = {
  roleName: string;
  login: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  inherit: boolean;
  replication: boolean;
  bypassRls: boolean;
  connectionLimit: number;
};

function roleQuery(roleName: string): string {
  return `SELECT rolname, rolcanlogin::text, rolsuper::text, rolcreatedb::text, rolcreaterole::text, rolinherit::text, rolreplication::text, rolbypassrls::text, rolconnlimit::text FROM pg_roles WHERE rolname = ${
    pgLiteral(roleName)
  };`;
}

async function inspectRole(
  context: MethodContext,
  ga: GlobalArguments,
): Promise<RoleRow | null> {
  const result = await execPsql(
    context,
    ga,
    "postgres",
    roleQuery(ga.roleName),
    {},
    { tuplesOnly: true },
  );
  const row = parsePipeRow(result.stdout);
  if (!row || row.length !== 9) return null;
  return {
    roleName: row[0],
    login: parsePgBoolean(row[1]),
    superuser: parsePgBoolean(row[2]),
    createdb: parsePgBoolean(row[3]),
    createrole: parsePgBoolean(row[4]),
    inherit: parsePgBoolean(row[5]),
    replication: parsePgBoolean(row[6]),
    bypassRls: parsePgBoolean(row[7]),
    connectionLimit: Number.parseInt(row[8], 10),
  };
}

function roleAttributeClauses(
  ga: GlobalArguments,
  creating: boolean,
): string[] {
  const clauses = [ga.login ? "LOGIN" : "NOLOGIN"];
  const booleanAttributes = [
    ["superuser", "SUPERUSER", "NOSUPERUSER"],
    ["createdb", "CREATEDB", "NOCREATEDB"],
    ["createrole", "CREATEROLE", "NOCREATEROLE"],
    ["inherit", "INHERIT", "NOINHERIT"],
    ["replication", "REPLICATION", "NOREPLICATION"],
    ["bypassRls", "BYPASSRLS", "NOBYPASSRLS"],
  ] as const;
  for (const [key, enabled, disabled] of booleanAttributes) {
    const value = ga[key];
    if (creating || value !== undefined) {
      clauses.push(value ? enabled : disabled);
    }
  }
  if (ga.connectionLimit !== undefined) {
    clauses.push(`CONNECTION LIMIT ${ga.connectionLimit}`);
  } else if (creating) {
    clauses.push("CONNECTION LIMIT -1");
  }
  return clauses;
}

function createRoleSql(ga: GlobalArguments): string {
  const password = ga.password === undefined
    ? ""
    : " PASSWORD :'role_password'";
  return `CREATE ROLE ${pgIdent(ga.roleName)} WITH ${
    roleAttributeClauses(ga, true).join(" ")
  }${password};`;
}

function alterRoleSql(ga: GlobalArguments): string | null {
  const clauses = roleAttributeClauses(ga, false);
  if (ga.password !== undefined) clauses.push("PASSWORD :'role_password'");
  return clauses.length > 0
    ? `ALTER ROLE ${pgIdent(ga.roleName)} WITH ${clauses.join(" ")};`
    : null;
}

function stateFromRow(ga: GlobalArguments, row: RoleRow | null) {
  return {
    exists: row !== null,
    host: ga.host,
    containerName: ga.containerName,
    roleName: ga.roleName,
    ...(row === null ? {} : {
      login: row.login,
      superuser: row.superuser,
      createdb: row.createdb,
      createrole: row.createrole,
      inherit: row.inherit,
      replication: row.replication,
      bypassRls: row.bypassRls,
      connectionLimit: row.connectionLimit,
    }),
    observedAt: new Date().toISOString(),
  };
}

function writeState(
  context: MethodContext,
  ga: GlobalArguments,
  row: RoleRow | null,
): Promise<{ name: string }> {
  return context.writeResource("role", "current", stateFromRow(ga, row));
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
    roleName: ga.roleName,
    changed,
    success: true,
    timestamp: new Date().toISOString(),
  });
}

export const model = {
  type: "@holi0317/postgres/role",
  version: "2026.08.16.1",
  globalArguments: GlobalArgumentsSchema,
  resources: {
    role: {
      description: "Observed PostgreSQL role state without its password",
      schema: RoleStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a PostgreSQL role method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe whether the role matches the remote cluster state",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const row = await inspectRole(context, ga);
        const stateHandle = await writeState(context, ga, row);
        const resultHandle = await writeRunResult(context, ga, "check", false);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description: "Create or converge one PostgreSQL role",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const before = await inspectRole(context, ga);
        if (before === null) {
          await execPsql(
            context,
            ga,
            "postgres",
            createRoleSql(ga),
            ga.password === undefined ? {} : { role_password: ga.password },
          );
        } else {
          const sql = alterRoleSql(ga);
          if (sql !== null) {
            await execPsql(
              context,
              ga,
              "postgres",
              sql,
              ga.password === undefined ? {} : { role_password: ga.password },
            );
          }
        }
        const after = await inspectRole(context, ga);
        if (after === null) {
          throw new Error(
            `PostgreSQL role ${ga.roleName} was not found after apply`,
          );
        }
        const stateHandle = await writeState(context, ga, after);
        const resultHandle = await writeRunResult(context, ga, "apply", true);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    destroy: {
      description: "Drop the role after its owned objects have been handled",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying PostgreSQL role ${ga.roleName} requires allowDestroy=true`,
          );
        }
        await execPsql(
          context,
          ga,
          "postgres",
          `DROP ROLE IF EXISTS ${pgIdent(ga.roleName)};`,
        );
        const stateHandle = await writeState(context, ga, null);
        const resultHandle = await writeRunResult(context, ga, "destroy", true);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    rotate_password: {
      description: "Change the role password without persisting it",
      arguments: RotatePasswordArgsSchema,
      execute: async (
        args: z.infer<typeof RotatePasswordArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        await execPsql(
          context,
          ga,
          "postgres",
          `ALTER ROLE ${pgIdent(ga.roleName)} PASSWORD :'role_password';`,
          { role_password: args.newPassword },
        );
        const after = await inspectRole(context, ga);
        if (after === null) {
          throw new Error(
            `PostgreSQL role ${ga.roleName} was not found after rotation`,
          );
        }
        const stateHandle = await writeState(context, ga, after);
        const resultHandle = await writeRunResult(
          context,
          ga,
          "rotate_password",
          true,
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
