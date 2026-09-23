import { Schema } from "effect";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "./payloads";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const ScriptNameSchema = Schema.Literals([
  "setup",
  "teardown",
  "port-pool-provision",
  "port-pool-release",
]);
export type ScriptName = typeof ScriptNameSchema.Type;

export const RunScriptPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  script: ScriptNameSchema,
});

const PackageManagerSchema = Schema.Literals(["bun", "pnpm", "yarn", "npm"]);
export type PackageManager = typeof PackageManagerSchema.Type;

const PackageScriptUsageSchema = Schema.Struct({
  // Epoch ms of the most recent run; 0 when the script has never been run.
  lastUsed: NonNegativeInt,
  // Number of runs within the rolling-frequency window (matches the
  // launcher's algorithm). 0 when the script has never been run inside
  // the window.
  recentCount: NonNegativeInt,
});
export type PackageScriptUsage = typeof PackageScriptUsageSchema.Type;

export const PackageScriptsResultSchema = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
  packageManager: PackageManagerSchema,
  usage: Schema.Record(Schema.String, PackageScriptUsageSchema),
});
export type PackageScriptsResult = typeof PackageScriptsResultSchema.Type;

export const PackageScriptSortModeSchema = Schema.Literals([
  "manifest",
  "alphabetical",
  "recent",
  "frequent",
]);
export type PackageScriptSortMode = typeof PackageScriptSortModeSchema.Type;

export const RunPackageScriptPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  scriptName: Schema.NonEmptyString,
});

export const SetPackageScriptSortPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  mode: PackageScriptSortModeSchema,
});

export const CancelScriptPayloadSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
});

// Keystrokes the console forwards to the run's PTY, exactly as xterm
// encodes them (control characters, escape sequences for arrows, ...).
export const WriteScriptPayloadSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  data: Schema.String,
});

// The console's viewport in cells. The PTY window size follows it.
export const ResizeScriptPayloadSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  cols: PositiveInt,
  rows: PositiveInt,
});

// "data" is the run's terminal output (stdout and stderr share the
// PTY, so xterm renders them in true interleave order). "error" covers
// spawn failures. "exit" is the final code (null if the process died
// from a signal or we cancelled).
export const ScriptEventSchema = Schema.Union([
  Schema.Struct({
    runId: Schema.String,
    kind: Schema.Literal("data"),
    data: Schema.String,
  }),
  Schema.Struct({
    runId: Schema.String,
    kind: Schema.Literal("exit"),
    code: Schema.NullOr(Schema.Finite),
  }),
  Schema.Struct({
    runId: Schema.String,
    kind: Schema.Literal("error"),
    data: Schema.String,
  }),
  // Emitted by the CLI when it initiates a lifecycle script (forwarded
  // by cliDelegate); lets the renderer bind runId -> slot before
  // data/exit arrive.
  Schema.Struct({
    runId: Schema.String,
    kind: Schema.Literal("started"),
    projectId: Schema.String,
    worktreeId: Schema.String,
    slot: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("setup") }),
      Schema.Struct({ kind: Schema.Literal("teardown") }),
      Schema.Struct({
        kind: Schema.Literal("portPool"),
        phase: Schema.Literals(["provision", "release"]),
      }),
    ]),
  }),
]);
export type ScriptEvent = typeof ScriptEventSchema.Type;

// Scripts the app had running in a worktree that disappeared from disk
// while the app was watching (an `sm rm` in a terminal). The app kills
// them and tells the renderer, which has no other way to explain why a
// dev server went down.
export const RemovedWorktreeScriptsSchema = Schema.Struct({
  worktreeId: Schema.String,
  worktreeName: Schema.String,
  scriptCount: PositiveInt,
});
export type RemovedWorktreeScripts = typeof RemovedWorktreeScriptsSchema.Type;

// Result of the boot sweep for scripts a previous session left running
// (host/lib/scripts/persistence.ts). Drained once by the renderer,
// which is the only place those runs can still be reported: their
// consoles died with the session that started them.
export const OrphanScriptReportSchema = Schema.Struct({
  stopped: NonNegativeInt,
});
export type OrphanScriptReport = typeof OrphanScriptReportSchema.Type;
