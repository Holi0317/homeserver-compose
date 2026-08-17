// deno-lint-ignore-file no-import-prefix
import * as z from "npm:zod@4";
import { isSafeUnitName } from "./validation.ts";

export const RemoteTargetSchema = z.object({
  fleet: z.string().min(1).describe("@swamp/ssh fleet model instance"),
  host: z.string().min(1).describe("Logical host name in the fleet"),
  sudo: z.boolean().default(false).describe(
    "Use sudo for system-mode systemctl and file operations",
  ),
});

export const FileRecordSchema = z.object({
  remoteName: z.string(),
  targetDir: z.string(),
  sha256: z.string(),
});

export const RunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  unitName: z.string(),
  changed: z.boolean(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable().optional(),
  replacementRequired: z.boolean().optional(),
  recreated: z.boolean().optional(),
  oldIdentity: z.string().optional(),
  newIdentity: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.iso.datetime(),
});

export const ReadinessSchema = z.object({
  helperServiceName: z.string().min(1)
    .refine(
      (name) => isSafeUnitName(name),
      "must be a valid systemd unit name no longer than 255 characters",
    )
    .refine((name) => name.endsWith(".service"), "must be a raw .service name"),
  helperServiceContent: z.string().describe(
    "Raw systemd .service contents; must be Type=oneshot with a blocking ExecStart",
  ),
  timeoutSeconds: z.number().int().positive().default(60),
  pollIntervalSeconds: z.number().int().positive().default(2),
});

export const ApplyArgsSchema = z.object({
  allowRecreate: z.boolean().default(false).describe(
    "Permit destroy-then-create replacement",
  ),
  readiness: ReadinessSchema.optional(),
});

export const DestroyArgsSchema = z.object({
  removeFiles: z.boolean().default(true).describe(
    "Remove unit files previously uploaded by this model instance",
  ),
});

export type Readiness = z.infer<typeof ReadinessSchema>;
export type ApplyArgs = z.infer<typeof ApplyArgsSchema>;
export type DestroyArgs = z.infer<typeof DestroyArgsSchema>;

/** Build the explicit global arguments contract for one model family member. */
export function createGlobalArgumentsSchema(
  extensions: readonly string[],
  suffixLabel: string,
  contentDescription: string,
) {
  return z.object({
    remote: RemoteTargetSchema,
    timeoutSeconds: z.number().int().positive().default(300)
      .describe("Per-command timeout passed to @swamp/ssh"),
    unitName: z.string().min(1)
      .refine(
        (name) => isSafeUnitName(name),
        "must be a valid systemd unit name no longer than 255 characters",
      )
      .refine(
        (name) => extensions.some((extension) => name.endsWith(extension)),
        `must end with ${suffixLabel} suffix (${extensions.join(", ")})`,
      ),
    content: z.string().optional().describe(contentDescription),
    userMode: z.enum(["system", "user"]).default("system"),
    enabled: z.boolean().optional().describe(
      "If provided, converge whether the resource is enabled",
    ),
    state: z.enum(["running", "stopped"]).optional().describe(
      "If provided, converge the active state",
    ),
  });
}
