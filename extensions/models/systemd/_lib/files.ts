import {
  ensureDir,
  runRemoteExec,
  shlexQuote,
  uploadFile,
} from "@holi0317/remote-ssh";
import { sha256 } from "./validation.ts";
import type {
  CommandResult,
  FileRecord,
  GlobalArgs,
  MethodContext,
} from "./types.ts";

export async function uploadManagedFile(
  ctx: MethodContext,
  ga: GlobalArgs,
  targetDir: string,
): Promise<FileRecord> {
  if (ga.content === undefined) {
    throw new Error("Cannot upload a managed file without content");
  }
  await ensureDir(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    targetDir,
    ga.userMode,
    ga.remote.sudo,
    ga.timeoutSeconds,
  );
  await uploadFile(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    `${targetDir}${ga.unitName}`,
    ga.content,
    ga.userMode,
    ga.remote.sudo,
    ga.timeoutSeconds,
  );
  return {
    remoteName: ga.unitName,
    targetDir,
    sha256: await sha256(ga.content),
  };
}

export async function removeTrackedFiles(
  ctx: MethodContext,
  ga: GlobalArgs,
  files: FileRecord[],
): Promise<CommandResult | undefined> {
  let result: CommandResult | undefined;
  for (const file of files) {
    const removed = await runRemoteExec(
      ctx,
      ga.remote.fleet,
      ga.remote.host,
      {
        command: `rm -f ${shlexQuote(`${file.targetDir}${file.remoteName}`)}`,
        sudo: ga.userMode === "system" && ga.remote.sudo,
        timeoutSec: ga.timeoutSeconds,
      },
    );
    if (removed.exitCode !== 0) {
      throw new Error(
        `Failed to remove ${file.targetDir}${file.remoteName}: ${removed.stderr}`,
      );
    }
    result = removed;
  }
  return result;
}
