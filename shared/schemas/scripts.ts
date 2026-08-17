import { z } from "zod";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "./payloads";

export const ScriptNameSchema = z.enum([
  "setup",
  "teardown",
  "port-pool-provision",
  "port-pool-release",
]);
export type ScriptName = z.infer<typeof ScriptNameSchema>;

export const RunScriptPayloadSchema = WorktreeScopedPayloadSchema.extend({
  script: ScriptNameSchema,
});

export const PackageManagerSchema = z.enum(["bun", "pnpm", "yarn", "npm"]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const PackageScriptUsageSchema = z.object({
  // Epoch ms of the most recent run; 0 when the script has never been run.
  lastUsed: z.number().int().nonnegative(),
  // Number of runs within the rolling-frequency window (matches the
  // launcher's algorithm). 0 when the script has never been run inside
  // the window.
  recentCount: z.number().int().nonnegative(),
});
export type PackageScriptUsage = z.infer<typeof PackageScriptUsageSchema>;

export const PackageScriptsResultSchema = z.object({
  scripts: z.record(z.string(), z.string()),
  packageManager: PackageManagerSchema,
  usage: z.record(z.string(), PackageScriptUsageSchema),
});
export type PackageScriptsResult = z.infer<typeof PackageScriptsResultSchema>;

export const PackageScriptSortModeSchema = z.enum([
  "manifest",
  "alphabetical",
  "recent",
  "frequent",
]);
export type PackageScriptSortMode = z.infer<typeof PackageScriptSortModeSchema>;

export const RunPackageScriptPayloadSchema = WorktreeScopedPayloadSchema.extend(
  {
    scriptName: z.string().min(1),
  },
);

export const SetPackageScriptSortPayloadSchema =
  ProjectScopedPayloadSchema.extend({
    mode: PackageScriptSortModeSchema,
  });

export const CancelScriptPayloadSchema = z.object({
  runId: z.string().min(1),
});

// stdout and stderr are merged into one "data" event so xterm renders
// them in true interleave order (matches how a terminal would show
// them). "error" covers spawn failures; "exit" is the final code
// (null if the process died from a signal or we cancelled).
export const ScriptEventSchema = z.discriminatedUnion("kind", [
  z.object({ runId: z.string(), kind: z.literal("data"), data: z.string() }),
  z.object({
    runId: z.string(),
    kind: z.literal("exit"),
    code: z.number().nullable(),
  }),
  z.object({ runId: z.string(), kind: z.literal("error"), data: z.string() }),
  // Emitted by the CLI when it initiates a lifecycle script (forwarded
  // by cliDelegate); lets the renderer bind runId -> slot before
  // data/exit arrive.
  z.object({
    runId: z.string(),
    kind: z.literal("started"),
    projectId: z.string(),
    worktreeId: z.string(),
    slot: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("setup") }),
      z.object({ kind: z.literal("teardown") }),
      z.object({
        kind: z.literal("portPool"),
        phase: z.enum(["provision", "release"]),
      }),
    ]),
  }),
]);
export type ScriptEvent = z.infer<typeof ScriptEventSchema>;
