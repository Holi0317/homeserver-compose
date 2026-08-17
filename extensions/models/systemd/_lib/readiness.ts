import { uploadFile } from "@holi0317/remote-ssh";
import type { Readiness } from "./schemas.ts";
import { RAW_SYSTEMD_DIRECTORIES, systemdTargetDirectory } from "./paths.ts";
import { execSystemctl } from "./systemctl.ts";
import type { GlobalArgs, MethodContext } from "./types.ts";

export async function readinessGate(
  readiness: Readiness,
  ctx: MethodContext,
  ga: GlobalArgs,
): Promise<void> {
  const helperDir = await systemdTargetDirectory(
    ctx,
    ga,
    RAW_SYSTEMD_DIRECTORIES,
  );
  await uploadFile(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    `${helperDir}${readiness.helperServiceName}`,
    readiness.helperServiceContent,
    ga.userMode,
    ga.remote.sudo,
    ga.timeoutSeconds,
  );
  let result = await execSystemctl(ctx, ga, ["daemon-reload"]);
  if (result.exitCode !== 0) {
    throw new Error(`daemon-reload failed: ${result.stderr}`);
  }
  result = await execSystemctl(ctx, ga, ["start", readiness.helperServiceName]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start readiness helper ${readiness.helperServiceName}: ${result.stderr}`,
    );
  }
  const deadline = Date.now() + readiness.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    result = await execSystemctl(
      ctx,
      ga,
      ["is-active", readiness.helperServiceName],
      [0, 3],
    );
    const state = result.stdout.trim();
    if (state === "active") return;
    if (state === "failed" || state === "inactive") {
      const status = await execSystemctl(
        ctx,
        ga,
        ["status", readiness.helperServiceName],
      );
      throw new Error(
        `Readiness helper ${readiness.helperServiceName} reached state "${state}". Status: ${status.stdout}\n${status.stderr}`,
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, readiness.pollIntervalSeconds * 1000)
    );
  }
  throw new Error(
    `Readiness helper ${readiness.helperServiceName} timed out after ${readiness.timeoutSeconds}s`,
  );
}
