import * as Schema from "effect/Schema";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "./payloads.ts";

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

const PackageScriptUsageSchema = Schema.Struct({
  // Epoch ms of the most recent run; 0 when the script has never been run.
  lastUsed: Schema.Natural,
  // Number of runs within the rolling-frequency window (matches the
  // launcher's algorithm). 0 when the script has never been run inside
  // the window.
  recentCount: Schema.Natural,
});
export type PackageScriptUsage = typeof PackageScriptUsageSchema.Type;

export const PackageScriptsResultSchema = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
  packageManager: PackageManagerSchema,
  usage: Schema.Record(Schema.String, PackageScriptUsageSchema),
  // The scripts picked for the launch row under the "manual" sort,
  // project-wide (see readLaunchRow). Rides the listing rather than a
  // call of its own.
  launchRow: Schema.Array(Schema.String),
});
export type PackageScriptsResult = typeof PackageScriptsResultSchema.Type;

export const PackageScriptSortModeSchema = Schema.Literals([
  "manifest",
  "alphabetical",
  "recent",
  "frequent",
  "manual",
]);
export type PackageScriptSortMode = typeof PackageScriptSortModeSchema.Type;

// `sm run --json` with no script: the worktree's package.json scripts
// in manifest order, the manager its lockfile selects, each script's
// use stats, and the project's saved sort and manual order.
export const PackageScriptsDocSchema = Schema.Struct({
  packageManager: PackageManagerSchema,
  scripts: Schema.Array(
    Schema.Struct({ name: Schema.String, command: Schema.String }),
  ),
  usage: Schema.Record(Schema.String, PackageScriptUsageSchema),
  sort: PackageScriptSortModeSchema,
  order: Schema.Array(Schema.String),
});
export type PackageScriptsDoc = typeof PackageScriptsDocSchema.Type;

export const RunPackageScriptPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  scriptName: Schema.NonEmptyString,
});

export const SetPackageScriptSortPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  mode: PackageScriptSortModeSchema,
});

// "manual" is newer than the other modes, and a client from before it
// has no case for it. getSort only answers "manual" to a caller that
// says it knows the mode. Anyone else gets the package.json order.
export const GetPackageScriptSortPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  knowsManual: Schema.optional(Schema.Boolean),
});

// The "manual" sort's order, as script names. Project-wide while the
// scripts themselves are per worktree, so it can name scripts a given
// worktree's package.json lacks (those are skipped), and a script it
// doesn't name trails the list in package.json order.
export const PackageScriptOrderSchema = Schema.Array(Schema.NonEmptyString);

// One worktree's scripts, all of them, in the order they were arranged
// into. The host merges it into the stored order under its lock.
export const SetPackageScriptOrderPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  arranged: PackageScriptOrderSchema,
});

export const SetPackageScriptLaunchRowPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  scriptName: Schema.NonEmptyString,
  onRow: Schema.Boolean,
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

// The slots a lifecycle script the CLI runs on the app's behalf can
// take.
const LifecycleSlotSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("setup") }),
  Schema.Struct({ kind: Schema.Literal("teardown") }),
  Schema.Struct({
    kind: Schema.Literal("portPool"),
    phase: Schema.Literals(["provision", "release"]),
  }),
]);

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
  // data/exit arrive. `pid` is the script's process once it has one
  // (absent when the spawn itself failed), which is what the host
  // signals to stop the run.
  Schema.Struct({
    runId: Schema.String,
    kind: Schema.Literal("started"),
    projectId: Schema.String,
    worktreeId: Schema.String,
    pid: Schema.optional(PositiveInt),
    slot: LifecycleSlotSchema,
  }),
]);
export type ScriptEvent = typeof ScriptEventSchema.Type;

// The slot a run occupies on its worktree, in the renderer's terms
// (store/scriptSlot.ts): a lifecycle script, or a package.json script
// by name.
const ScriptRunSlotSchema = Schema.Union([
  ...LifecycleSlotSchema.members,
  Schema.Struct({ kind: Schema.Literal("package"), name: Schema.String }),
]);
export type ScriptRunSlot = typeof ScriptRunSlotSchema.Type;
export type LifecycleSlot = typeof LifecycleSlotSchema.Type;

// The two names of a lifecycle script: the slot it takes on its
// worktree and the ScriptName that asks for it (scripts:run).
export function lifecycleSlot(script: ScriptName): LifecycleSlot {
  switch (script) {
    case "setup":
    case "teardown":
      return { kind: script };
    case "port-pool-provision":
      return { kind: "portPool", phase: "provision" };
    case "port-pool-release":
      return { kind: "portPool", phase: "release" };
  }
}

export function lifecycleScriptName(slot: LifecycleSlot): ScriptName {
  return slot.kind === "portPool" ? `port-pool-${slot.phase}` : slot.kind;
}

// The name a run goes by (SHIGOMORI_SCRIPT_NAME, the logs): a package
// script's own, or the lifecycle script's.
export function runScriptName(slot: ScriptRunSlot): string {
  return slot.kind === "package" ? slot.name : lifecycleScriptName(slot);
}

// How an error reads in a run's console, the same whether the renderer
// prints it as it happens or the host replays it to a late attach.
export function scriptErrorLine(message: string): string {
  return `\r\n\x1b[31m${message}\x1b[0m\r\n`;
}

// One script running on the host right now, whoever started it: the
// app's own runs and the lifecycle scripts the CLI runs for it. What a
// window that never saw the run start (a reload, another device) needs
// to show it and bind its events. `interactive` is whether it owns a
// PTY here that keystrokes can reach.
const RunningScriptSchema = Schema.Struct({
  runId: Schema.String,
  projectId: Schema.String,
  worktreeId: Schema.String,
  slot: ScriptRunSlotSchema,
  startedAt: Schema.Natural,
  interactive: Schema.Boolean,
});
export type RunningScript = typeof RunningScriptSchema.Type;

export const RunningScriptsSchema = Schema.Struct({
  runs: Schema.Array(RunningScriptSchema),
});

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
  stopped: Schema.Natural,
});
export type OrphanScriptReport = typeof OrphanScriptReportSchema.Type;
