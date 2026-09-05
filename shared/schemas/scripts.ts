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

// Keystrokes the console forwards to the run's PTY, exactly as xterm
// encodes them (control characters, escape sequences for arrows, ...).
export const WriteScriptPayloadSchema = z.object({
  runId: z.string().min(1),
  data: z.string(),
});

// The console's viewport in cells. The PTY window size follows it.
export const ResizeScriptPayloadSchema = z.object({
  runId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

// "data" is the run's terminal output (stdout and stderr share the
// PTY, so xterm renders them in true interleave order). "error" covers
// spawn failures. "exit" is the final code (null if the process died
// from a signal or we cancelled).
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

// Scripts the app had running in a worktree that disappeared from disk
// while the app was watching (an `sm rm` in a terminal). The app kills
// them and tells the renderer, which has no other way to explain why a
// dev server went down.
export const RemovedWorktreeScriptsSchema = z.object({
  worktreeId: z.string(),
  worktreeName: z.string(),
  scriptCount: z.number().int().positive(),
});
export type RemovedWorktreeScripts = z.infer<
  typeof RemovedWorktreeScriptsSchema
>;

// Result of the boot sweep for scripts a previous session left running
// (main/lib/scripts/persistence.ts). Drained once by the renderer,
// which is the only place those runs can still be reported: their
// consoles died with the session that started them.
export const OrphanScriptReportSchema = z.object({
  stopped: z.number().int().nonnegative(),
});
export type OrphanScriptReport = z.infer<typeof OrphanScriptReportSchema>;
