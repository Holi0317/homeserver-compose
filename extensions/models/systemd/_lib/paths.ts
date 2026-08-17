import { discoverHome, type RemoteContext } from "@holi0317/remote-ssh";
import type { GlobalArgs } from "./types.ts";

export const RAW_SYSTEMD_DIRECTORIES = {
  system: "/etc/systemd/system/",
  user: ".config/systemd/user/",
} as const;

export const QUADLET_DIRECTORIES = {
  system: "/etc/containers/systemd/",
  user: ".config/containers/systemd/",
} as const;

export async function systemdTargetDirectory(
  ctx: RemoteContext,
  ga: GlobalArgs,
  directories: { system: string; user: string },
): Promise<string> {
  if (ga.userMode === "system") return directories.system;
  const home = await discoverHome(
    ctx,
    ga.remote.fleet,
    ga.remote.host,
    ga.timeoutSeconds,
  );
  return `${home}/${directories.user}`;
}
