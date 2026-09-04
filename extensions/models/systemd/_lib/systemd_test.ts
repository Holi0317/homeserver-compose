import { model as quadlet } from "../quadlet.ts";
import { model as unit } from "../unit.ts";

const remote = { fleet: "fleet", host: "host", sudo: true };
const unitApply = unit.methods.apply.execute as unknown as (
  args: unknown,
  context: unknown,
) => Promise<unknown>;
const quadletApply = quadlet.methods.apply.execute as unknown as (
  args: unknown,
  context: unknown,
) => Promise<unknown>;

function fakeContext(
  globalArgs: Record<string, unknown>,
  stored: Record<string, unknown> | null,
) {
  let remoteCalls = 0;
  const writes: Array<{ spec: string; name: string }> = [];
  return {
    context: {
      globalArgs,
      readResource: () => Promise.resolve(stored),
      writeResource: (spec: string, name: string) => {
        writes.push({ spec, name });
        return Promise.resolve({ name });
      },
      deleteResource: () => Promise.resolve(),
      runModel: () => {
        remoteCalls++;
        return Promise.reject(
          new Error("remote operation should not have been reached"),
        );
      },
    },
    get remoteCalls() {
      return remoteCalls;
    },
    writes,
  };
}

Deno.test("unit and Quadlet schemas reject cross-kind and path traversal names", () => {
  const raw = unit.globalArguments.safeParse({
    remote,
    unitName: "postgres.service",
    userMode: "system",
  });
  if (!raw.success) throw new Error("valid raw unit was rejected");

  const traversal = unit.globalArguments.safeParse({
    remote,
    unitName: "../../tmp/evil.service",
    userMode: "system",
  });
  if (traversal.success) {
    throw new Error("raw unit path traversal was accepted");
  }

  const wrongKind = quadlet.globalArguments.safeParse({
    remote,
    unitName: "postgres.service",
    userMode: "system",
  });
  if (wrongKind.success) throw new Error("raw suffix was accepted by Quadlet");

  const helper = unit.methods.apply.arguments.safeParse({
    readiness: {
      helperServiceName: "../../tmp/helper.service",
      helperServiceContent: "",
    },
  });
  if (helper.success) throw new Error("readiness path traversal was accepted");
  const invalidCharacters = unit.globalArguments.safeParse({
    remote,
    unitName: "postgres service.service",
    userMode: "system",
  });
  if (invalidCharacters.success) {
    throw new Error("unit names with spaces were accepted");
  }

  const tooLong = unit.globalArguments.safeParse({
    remote,
    unitName: `${"a".repeat(248)}.service`,
    userMode: "system",
  });
  if (tooLong.success) throw new Error("overlong unit name was accepted");

  const templateInstance = unit.globalArguments.safeParse({
    remote,
    unitName: "worker@blue.service",
    userMode: "system",
  });
  if (!templateInstance.success) {
    throw new Error("valid systemd template instance was rejected");
  }

  const escaped = unit.globalArguments.safeParse({
    remote,
    unitName: "disk\\x2dunit.service",
    userMode: "system",
  });
  if (!escaped.success) {
    throw new Error("valid systemd backslash escape was rejected");
  }
});

Deno.test("apply refuses remote-target replacement before remote work", async () => {
  const stored = {
    userMode: "system",
    fleet: "fleet",
    host: "old-host",
    sudo: true,
    unitName: "postgres.service",
    files: [],
    deployedAt: new Date().toISOString(),
  };
  const fake = fakeContext({
    remote,
    unitName: "postgres.service",
    userMode: "system",
  }, stored);

  try {
    await unitApply(
      { allowRecreate: false },
      fake.context,
    );
    throw new Error("remote-target replacement was not rejected");
  } catch (error) {
    if (!String(error).includes("Replacement required")) throw error;
  }

  if (fake.remoteCalls !== 0) {
    throw new Error(
      `replacement refusal made ${fake.remoteCalls} remote calls`,
    );
  }
  if (!fake.writes.some((write) => write.spec === "runResult")) {
    throw new Error("replacement refusal did not write a diagnostic result");
  }
});

Deno.test("Quadlet apply rejects unsafe WantedBy targets before remote work", async () => {
  const fake = fakeContext({
    remote,
    unitName: "postgres.container",
    userMode: "system",
    content: "[Install]\nWantedBy=../../tmp",
  }, null);

  try {
    await quadletApply(
      { allowRecreate: false },
      fake.context,
    );
    throw new Error("unsafe WantedBy target was not rejected");
  } catch (error) {
    if (!String(error).includes("WantedBy target")) throw error;
  }

  if (fake.remoteCalls !== 0) {
    throw new Error(
      `unsafe WantedBy validation made ${fake.remoteCalls} remote calls`,
    );
  }
});

Deno.test("apply converges global enabled and state arguments", async () => {
  const commands: string[] = [];
  const writes: Array<{ spec: string; data: Record<string, unknown> }> = [];
  const context = {
    globalArgs: {
      remote,
      unitName: "postgres.service",
      userMode: "system",
      enabled: true,
      state: "running",
    },
    readResource: () => Promise.resolve(null),
    writeResource: (
      spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, data });
      return Promise.resolve({ name: _name });
    },
    deleteResource: () => Promise.resolve(),
    runModel: ({ arguments: args }: { arguments: { command: string } }) => {
      commands.push(args.command);
      const output = args.command.includes("is-enabled")
        ? "enabled\n"
        : args.command.includes("is-active")
        ? "active\n"
        : "";
      return Promise.resolve({
        ok: true,
        resources: [{
          attributes: { stdout: output, stderr: "", exitCode: 0 },
        }],
      });
    },
  };

  await unitApply({ allowRecreate: false }, context);

  if (!commands.some((command) => command.includes("'systemctl' 'enable'"))) {
    throw new Error("global enabled=true did not enable the unit");
  }
  if (!commands.some((command) => command.includes("'systemctl' 'start'"))) {
    throw new Error("global state=running did not start the unit");
  }
  const state = writes.find((write) => write.spec === "unit")?.data;
  if (state?.enabled !== true || state.active !== true) {
    throw new Error("apply did not persist actual lifecycle state");
  }
});

Deno.test("reload invokes systemctl and records a structured result", async () => {
  const commands: string[] = [];
  const writes: Array<{
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  const context = {
    globalArgs: {
      remote,
      unitName: "tailscale-serve.service",
      userMode: "system",
    },
    readResource: () => Promise.resolve(null),
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    deleteResource: () => Promise.resolve(),
    runModel: ({ arguments: args }: { arguments: { command: string } }) => {
      commands.push(args.command);
      return Promise.resolve({
        ok: true,
        resources: [{
          attributes: { stdout: "reloaded\n", stderr: "", exitCode: 0 },
        }],
      });
    },
  };

  const reload = unit.methods.reload.execute as unknown as (
    args: unknown,
    context: unknown,
  ) => Promise<unknown>;
  await reload({}, context);

  if (
    commands.length !== 1 || !commands[0].includes(
      "'systemctl' 'reload' 'tailscale-serve.service'",
    )
  ) {
    throw new Error("reload did not invoke systemctl reload for the unit");
  }
  const result = writes.find((write) => write.spec === "runResult");
  if (
    result?.name !== "reload" ||
    result.data.method !== "reload" ||
    result.data.success !== true ||
    result.data.changed !== true ||
    result.data.stdout !== "reloaded\n"
  ) {
    throw new Error("reload did not persist its structured run result");
  }
});

Deno.test("reload propagates systemctl failures", async () => {
  const context = {
    globalArgs: {
      remote,
      unitName: "tailscale-serve.service",
      userMode: "system",
    },
    readResource: () => Promise.resolve(null),
    writeResource: () => Promise.reject(new Error("run result was written")),
    deleteResource: () => Promise.resolve(),
    runModel: () =>
      Promise.resolve({
        ok: true,
        resources: [{
          attributes: { stdout: "", stderr: "unit is inactive", exitCode: 1 },
        }],
      }),
  };

  const reload = unit.methods.reload.execute as unknown as (
    args: unknown,
    context: unknown,
  ) => Promise<unknown>;
  try {
    await reload({}, context);
    throw new Error("reload failure did not propagate");
  } catch (error) {
    if (!String(error).includes("reload tailscale-serve.service failed")) {
      throw error;
    }
    if (!String(error).includes("unit is inactive")) throw error;
  }
});
