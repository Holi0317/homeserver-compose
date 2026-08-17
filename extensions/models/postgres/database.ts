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

const NameSchema = z.string().min(1).max(63).regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  "PostgreSQL names must contain only letters, digits, and underscores",
);

const GlobalArgumentsSchema = z.object({
  ...PostgresTargetSchema.shape,
  database: NameSchema.describe("Logical PostgreSQL database name"),
  ownerRole: NameSchema.describe("Single LOGIN role that owns the database"),
  encoding: z.string().min(1).default("UTF8").describe(
    "Encoding used when creating the database",
  ),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type MethodContext = PostgresMethodContext<GlobalArguments>;

const DatabaseStateSchema = z.object({
  exists: z.boolean(),
  host: z.string(),
  containerName: z.string(),
  database: z.string(),
  ownerRole: z.string().optional(),
  encoding: z.string().optional(),
  observedAt: z.iso.datetime(),
});

const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  database: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const CheckArgsSchema = z.object({});
const ApplyArgsSchema = z.object({});
const DestroyArgsSchema = z.object({
  allowDestroy: z.boolean().default(false).describe(
    "Permit dropping the database and its data",
  ),
});

type DatabaseRow = {
  database: string;
  ownerRole: string;
  encoding: string;
};

function databaseQuery(database: string): string {
  return `SELECT datname, pg_get_userbyid(datdba), pg_encoding_to_char(encoding) FROM pg_database WHERE datname = ${
    pgLiteral(database)
  };`;
}

async function inspectDatabase(
  context: MethodContext,
  ga: GlobalArguments,
): Promise<DatabaseRow | null> {
  const result = await execPsql(
    context,
    ga,
    "postgres",
    databaseQuery(ga.database),
    {},
    { tuplesOnly: true },
  );
  const row = parsePipeRow(result.stdout);
  if (!row || row.length !== 3) return null;
  return {
    database: row[0],
    ownerRole: row[1],
    encoding: row[2],
  };
}

async function assertOwnerRole(
  context: MethodContext,
  ga: GlobalArguments,
): Promise<void> {
  const result = await execPsql(
    context,
    ga,
    "postgres",
    `SELECT rolcanlogin::text FROM pg_roles WHERE rolname = ${
      pgLiteral(ga.ownerRole)
    };`,
    {},
    { tuplesOnly: true },
  );
  const row = result.stdout.trim();
  if (!row) {
    throw new Error(
      `Database owner role ${ga.ownerRole} does not exist; apply the role model first`,
    );
  }
  if (!parsePgBoolean(row)) {
    throw new Error(
      `Database owner role ${ga.ownerRole} must have LOGIN enabled`,
    );
  }
}

function createDatabaseSql(ga: GlobalArguments): string {
  return `CREATE DATABASE ${pgIdent(ga.database)} WITH OWNER ${
    pgIdent(
      ga.ownerRole,
    )
  } ENCODING ${pgLiteral(ga.encoding)} TEMPLATE template0;`;
}

function stateFromRow(ga: GlobalArguments, row: DatabaseRow | null) {
  return {
    exists: row !== null,
    host: ga.host,
    containerName: ga.containerName,
    database: ga.database,
    ...(row === null
      ? {}
      : { ownerRole: row.ownerRole, encoding: row.encoding }),
    observedAt: new Date().toISOString(),
  };
}

function writeState(
  context: MethodContext,
  ga: GlobalArguments,
  row: DatabaseRow | null,
): Promise<{ name: string }> {
  return context.writeResource("database", "current", stateFromRow(ga, row));
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
    database: ga.database,
    changed,
    success: true,
    timestamp: new Date().toISOString(),
  });
}

export const model = {
  type: "@holi0317/postgres/database",
  version: "2026.08.16.1",
  globalArguments: GlobalArgumentsSchema,
  resources: {
    database: {
      description: "Observed PostgreSQL database state",
      schema: DatabaseStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    runResult: {
      description: "Outcome of a PostgreSQL database method invocation",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Observe database existence, encoding, and ownership",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const row = await inspectDatabase(context, ga);
        const stateHandle = await writeState(context, ga, row);
        const resultHandle = await writeRunResult(context, ga, "check", false);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    apply: {
      description:
        "Create the database or converge its owner, reassigning objects owned by the previous owner",
      arguments: ApplyArgsSchema,
      execute: async (
        _args: z.infer<typeof ApplyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        await assertOwnerRole(context, ga);
        const before = await inspectDatabase(context, ga);
        let changed = false;
        if (before === null) {
          await execPsql(context, ga, "postgres", createDatabaseSql(ga));
          changed = true;
        } else {
          if (before.encoding !== ga.encoding) {
            throw new Error(
              `Database ${ga.database} has encoding ${before.encoding}; desired encoding ${ga.encoding} cannot be changed in place`,
            );
          }
          if (before.ownerRole !== ga.ownerRole) {
            await execPsql(
              context,
              ga,
              ga.database,
              `REASSIGN OWNED BY ${pgIdent(before.ownerRole)} TO ${
                pgIdent(
                  ga.ownerRole,
                )
              };`,
            );
            await execPsql(
              context,
              ga,
              "postgres",
              `ALTER DATABASE ${pgIdent(ga.database)} OWNER TO ${
                pgIdent(
                  ga.ownerRole,
                )
              };`,
            );
            changed = true;
          }
        }
        const after = await inspectDatabase(context, ga);
        if (after === null) {
          throw new Error(`Database ${ga.database} was not found after apply`);
        }
        const stateHandle = await writeState(context, ga, after);
        const resultHandle = await writeRunResult(
          context,
          ga,
          "apply",
          changed,
        );
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
    destroy: {
      description: "Drop the database without dropping its owner role",
      arguments: DestroyArgsSchema,
      execute: async (
        args: z.infer<typeof DestroyArgsSchema>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        if (!args.allowDestroy) {
          throw new Error(
            `Destroying PostgreSQL database ${ga.database} requires allowDestroy=true`,
          );
        }
        if (ga.database === "postgres") {
          throw new Error(
            "The bootstrap postgres database cannot be destroyed",
          );
        }
        await execPsql(
          context,
          ga,
          "postgres",
          `DROP DATABASE IF EXISTS ${pgIdent(ga.database)};`,
        );
        const stateHandle = await writeState(context, ga, null);
        const resultHandle = await writeRunResult(context, ga, "destroy", true);
        return { dataHandles: [stateHandle, resultHandle] };
      },
    },
  },
};
