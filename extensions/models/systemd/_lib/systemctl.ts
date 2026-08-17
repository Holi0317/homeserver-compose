import { runRemoteExec, shlexQuote, usesSudo } from "@holi0317/remote-ssh";
import type { CommandResult, GlobalArgs, MethodContext } from "./types.ts";

export function execSystemctl(
  ctx: MethodContext,
  ga: GlobalArgs,
  subcommand: string[],
  okExitCodes?: number[],
): Promise<CommandResult> {
  const parts = ["systemctl"];
  if (ga.userMode === "user") parts.push("--user");
  parts.push(...subcommand);
  return runRemoteExec(ctx, ga.remote.fleet, ga.remote.host, {
    command: parts.map(shlexQuote).join(" "),
    sudo: usesSudo(ga.userMode, ga.remote.sudo),
    timeoutSec: ga.timeoutSeconds,
    okExitCodes,
  });
}

export function systemctlShow(
  ctx: MethodContext,
  ga: GlobalArgs,
  runtimeName: string,
): Promise<CommandResult> {
  return execSystemctl(ctx, ga, [
    "show",
    runtimeName,
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "UnitFileState",
    "-p",
    "LoadState",
  ]);
}
