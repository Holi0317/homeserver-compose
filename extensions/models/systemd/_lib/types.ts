// deno-lint-ignore-file no-import-prefix
import type * as z from "npm:zod@4";
import type { RemoteContext } from "@holi0317/remote-ssh";

export interface RemoteTarget {
  fleet: string;
  host: string;
  sudo: boolean;
}

export interface GlobalArgs {
  remote: RemoteTarget;
  timeoutSeconds: number;
  unitName: string;
  content?: string;
  userMode: "system" | "user";
  enabled?: boolean;
  state?: "running" | "stopped";
}

export interface FileRecord {
  remoteName: string;
  targetDir: string;
  sha256: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ManagedState {
  userMode: "system" | "user";
  fleet?: string;
  host: string;
  sudo?: boolean;
  files: FileRecord[];
  wantedBy?: string[];
  enabled?: boolean;
  active?: boolean;
  deployedAt: string;
}

export interface MethodContext extends RemoteContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  deleteResource: (instanceName: string) => Promise<void>;
}

export interface ResourceTarget {
  userMode: "system" | "user";
  fleet: string;
  host: string;
  unitName: string;
}

/** Domain policy supplied by the concrete unit and Quadlet models. */
export interface SystemdOperations<State extends ManagedState> {
  stateSchema: z.ZodType<State>;
  targetDirectory: (
    ctx: MethodContext,
    ga: GlobalArgs,
  ) => Promise<string>;
  runtimeName: (sourceName: string) => string;
  stateName: (state: State) => string;
  identityForTarget: (target: ResourceTarget) => string;
  identityForState: (state: State) => string;
  wantedBy: (
    content: string | undefined,
    previousState: State | undefined,
  ) => string[];
  enablementTargets: (state: State) => string[];
  setEnablement: (
    ctx: MethodContext,
    ga: GlobalArgs,
    runtimeName: string,
    targets: string[],
    enabled: boolean,
  ) => Promise<CommandResult>;
  removeEnablement: (
    ctx: MethodContext,
    ga: GlobalArgs,
    runtimeName: string,
    targets: string[],
  ) => Promise<CommandResult | undefined>;
  reloadAfterDestroy: boolean;
  buildState: (
    ga: GlobalArgs,
    files: FileRecord[],
    wantedBy: string[],
    lifecycle: { enabled: boolean; active: boolean },
  ) => Record<string, unknown>;
}
