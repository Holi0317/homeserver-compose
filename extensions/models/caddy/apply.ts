import {
  ensureDir,
  runRemoteExec,
  shlexQuote,
  uploadFile,
} from "@holi0317/remote-ssh";
import {
  ApplyArgumentsSchema,
  ConfigGlobalArgumentsSchema,
} from "./schema.ts";
import { remotePath } from "./remote.ts";
import type { CaddyMethodContext, CaddyMethodResult } from "./context.ts";

export async function applyExecute(
  rawArgs: unknown,
  context: CaddyMethodContext,
): Promise<CaddyMethodResult> {
  const args = ApplyArgumentsSchema.parse(rawArgs);
  const globalArguments = ConfigGlobalArgumentsSchema.parse(
    context.globalArgs,
  );
  const remote = globalArguments.remote ?? args.remote;
  if (remote === undefined) {
    throw new Error("Caddy deployment requires a remote fleet and host");
  }
  const resource = await context.readResource(args.configName);
  if (
    resource === null || typeof resource.json !== "string" ||
    typeof resource.digest !== "string"
  ) {
    throw new Error(
      `Rendered Caddy configuration ${args.configName} was not found`,
    );
  }
  const digest = resource.digest;

  const candidatePath = remotePath(globalArguments.configDirectory, "caddy.json.next");
  const activePath = remotePath(globalArguments.configDirectory, "caddy.json");
  const previousPath = remotePath(globalArguments.configDirectory, "caddy.json.previous");
  let activated = false;
  let hadPrevious = false;
  let serviceAvailable = false;
  const serviceState = await runRemoteExec(
    context,
    remote.fleet,
    remote.host,
    {
      command: `systemctl show ${
        shlexQuote(globalArguments.serviceName)
      } --property=LoadState --value`,
      sudo: remote.sudo,
      okExitCodes: "any",
      timeoutSec: globalArguments.timeoutSeconds,
    },
  );
  const serviceLoadState = serviceState.stdout.trim();
  if (serviceState.exitCode !== 0 || serviceLoadState.length === 0) {
    throw new Error(
      `Failed to inspect Caddy service ${globalArguments.serviceName}: ${serviceState.stderr}`,
    );
  }
  serviceAvailable = serviceLoadState !== "not-found";
  try {
    await ensureDir(
      context,
      remote.fleet,
      remote.host,
      globalArguments.configDirectory,
      "system",
      remote.sudo,
      globalArguments.timeoutSeconds,
    );
    await uploadFile(
      context,
      remote.fleet,
      remote.host,
      candidatePath,
      resource.json,
      "system",
      remote.sudo,
      globalArguments.timeoutSeconds,
    );
    const remoteValidation = await runRemoteExec(
      context,
      remote.fleet,
      remote.host,
      {
        command: [
          "podman",
          "run",
          "--rm",
          "--volume",
          `${candidatePath}:/etc/caddy/caddy.json:ro,Z`,
          "--secret",
          "cloudflare-api-token,type=env,target=CLOUDFLARE_API_TOKEN",
          globalArguments.caddyImage,
          "caddy",
          "validate",
          "--config",
          "/etc/caddy/caddy.json",
        ].map(shlexQuote).join(" "),
        sudo: remote.sudo,
        timeoutSec: globalArguments.timeoutSeconds,
      },
    );
    if (remoteValidation.exitCode !== 0) {
      throw new Error(
        `Athena rejected the Caddy candidate: ${remoteValidation.stderr}`,
      );
    }

    const previousState = await runRemoteExec(
      context,
      remote.fleet,
      remote.host,
      {
        command: `test -f ${shlexQuote(activePath)}`,
        sudo: remote.sudo,
        okExitCodes: [0, 1],
        timeoutSec: globalArguments.timeoutSeconds,
      },
    );
    hadPrevious = previousState.exitCode === 0;
    const backupCommand = hadPrevious
      ? `cp -f ${shlexQuote(activePath)} ${shlexQuote(previousPath)}`
      : `rm -f ${shlexQuote(previousPath)}`;
    const backup = await runRemoteExec(
      context,
      remote.fleet,
      remote.host,
      {
        command: backupCommand,
        sudo: remote.sudo,
        timeoutSec: globalArguments.timeoutSeconds,
      },
    );
    if (backup.exitCode !== 0) {
      throw new Error(
        `Failed to preserve the previous Caddy config: ${backup.stderr}`,
      );
    }

    const activation = await runRemoteExec(
      context,
      remote.fleet,
      remote.host,
      {
        command: `mv -f ${shlexQuote(candidatePath)} ${shlexQuote(activePath)}`,
        sudo: remote.sudo,
        timeoutSec: globalArguments.timeoutSeconds,
      },
    );
    if (activation.exitCode !== 0) {
      throw new Error(
        `Failed to activate the Caddy candidate: ${activation.stderr}`,
      );
    }
    activated = true;

    if (serviceAvailable) {
      const reload = await runRemoteExec(
        context,
        remote.fleet,
        remote.host,
        {
          command: ["systemctl", "reload", globalArguments.serviceName]
            .map(shlexQuote).join(" "),
          sudo: remote.sudo,
          timeoutSec: globalArguments.timeoutSeconds,
        },
      );
      if (reload.exitCode !== 0) {
        throw new Error(`Caddy reload failed: ${reload.stderr}`);
      }
    }

    const digestResult = await runRemoteExec(
      context,
      remote.fleet,
      remote.host,
      {
        command: `sha256sum ${shlexQuote(activePath)}`,
        sudo: remote.sudo,
        timeoutSec: globalArguments.timeoutSeconds,
      },
    );
    if (digestResult.exitCode !== 0) {
      throw new Error(
        `Failed to read the active Caddy digest: ${digestResult.stderr}`,
      );
    }
    const remoteDigest = digestResult.stdout.trim().split(/\s+/)[0];
    if (remoteDigest !== digest) {
      throw new Error(
        `Active Caddy digest ${remoteDigest} does not match rendered digest ${digest}`,
      );
    }

    const handle = await context.writeResource("deployment", "current", {
      digest,
      remoteDigest,
      candidatePath,
      activePath,
      serviceName: globalArguments.serviceName,
      backupPath: hadPrevious ? previousPath : undefined,
      rolledBack: false,
      appliedAt: new Date().toISOString(),
    });
    return { dataHandles: [handle] };
  } catch (error) {
    let rollbackFailure: unknown;
    if (activated) {
      const rollbackCommand = hadPrevious
        ? `mv -f ${shlexQuote(previousPath)} ${shlexQuote(activePath)}`
        : `rm -f ${shlexQuote(activePath)}`;
      try {
        const rollback = await runRemoteExec(
          context,
          remote.fleet,
          remote.host,
          {
            command: rollbackCommand,
            sudo: remote.sudo,
            timeoutSec: globalArguments.timeoutSeconds,
          },
        );
        if (rollback.exitCode !== 0) {
          rollbackFailure = new Error(
            `Rollback file operation failed: ${rollback.stderr}`,
          );
        }
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
      if (serviceAvailable) {
        try {
          const rollbackReload = await runRemoteExec(
            context,
            remote.fleet,
            remote.host,
            {
              command: [
                "systemctl",
                "reload",
                globalArguments.serviceName,
              ]
                .map(shlexQuote).join(" "),
              sudo: remote.sudo,
              okExitCodes: "any",
              timeoutSec: globalArguments.timeoutSeconds,
            },
          );
          if (rollbackReload.exitCode !== 0 && rollbackFailure === undefined) {
            rollbackFailure = new Error(
              `Rollback reload failed: ${rollbackReload.stderr}`,
            );
          }
        } catch (rollbackError) {
          if (rollbackFailure === undefined) {
            rollbackFailure = rollbackError;
          }
        }
      }
    }
    if (rollbackFailure !== undefined) {
      throw new Error(
        `${String(error)}; rollback failed: ${String(rollbackFailure)}`,
      );
    }
    throw error;
  } finally {
    const cleanup = await runRemoteExec(
      context,
      remote.fleet,
      remote.host,
      {
        command: `rm -f ${shlexQuote(candidatePath)}`,
        sudo: remote.sudo,
        okExitCodes: "any",
        timeoutSec: globalArguments.timeoutSeconds,
      },
    );
    if (cleanup.exitCode !== 0) {
      throw new Error(
        `Failed to remove the Caddy candidate ${candidatePath}: ${cleanup.stderr}`,
      );
    }
  }
}
