import type { RemoteContext } from "@holi0317/remote-ssh";

export type CaddyMethodContext = RemoteContext & {
  globalArgs: unknown;
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

export type CaddyMethodResult = { dataHandles: { name: string }[] };
