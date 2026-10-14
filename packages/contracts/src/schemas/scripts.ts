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

const PackageManagerSchema = Schema.NullOr(
  Schema.Literals(["bun", "pnpm", "yarn", "npm"]),
);

const PackageScriptUsageSchema = Schema.Struct({
  // 0 when never run.
  lastUsed: Schema.Natural,
  // Runs within the launcher's rolling-frequency window.
  recentCount: Schema.Natural,
});
export type PackageScriptUsage = typeof PackageScriptUsageSchema.Type;

// Each script's name mapped to the one it goes by there ("build" for
// "just build").
const ScriptGroupSchema = Schema.Struct({
  file: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
});
export type ScriptGroup = typeof ScriptGroupSchema.Type;

// package.json's by their own names, then "just <recipe>" and
// "make <target>".
export const PackageScriptsResultSchema = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
  packageManager: PackageManagerSchema,
  groups: Schema.Array(ScriptGroupSchema),
  usage: Schema.Record(Schema.String, PackageScriptUsageSchema),
  // Project-wide (see readLaunchRow).
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

export const PackageScriptsDocSchema = Schema.Struct({
  packageManager: PackageManagerSchema,
  scripts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      command: Schema.String,
      file: Schema.String,
      label: Schema.String,
    }),
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

// A client from before "manual" has no case for it, so getSort answers
// it only to a caller that says it knows the mode.
export const GetPackageScriptSortPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  knowsManual: Schema.optional(Schema.Boolean),
});

// Project-wide while scripts are per worktree: a name a worktree lacks
// is skipped, and a script it doesn't name trails in file order.
export const PackageScriptOrderSchema = Schema.Array(Schema.NonEmptyString);

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

// As xterm encodes them.
export const WriteScriptPayloadSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  data: Schema.String,
});

export const ResizeScriptPayloadSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  cols: PositiveInt,
  rows: PositiveInt,
});

const LifecycleSlotSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("setup") }),
  Schema.Struct({ kind: Schema.Literal("teardown") }),
  Schema.Struct({
    kind: Schema.Literal("portPool"),
    phase: Schema.Literals(["provision", "release"]),
  }),
]);

// stdout and stderr share the PTY, so "data" is in true interleave
// order. "exit" is null when a signal killed it.
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
  // Lets the renderer bind runId to slot before data arrives. `pid`, once
  // there is one, is what the host signals to stop the run.
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

const ScriptRunSlotSchema = Schema.Union([
  ...LifecycleSlotSchema.members,
  Schema.Struct({ kind: Schema.Literal("package"), name: Schema.String }),
]);
export type ScriptRunSlot = typeof ScriptRunSlotSchema.Type;
export type LifecycleSlot = typeof LifecycleSlotSchema.Type;

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

export function runScriptName(slot: ScriptRunSlot): string {
  return slot.kind === "package" ? slot.name : lifecycleScriptName(slot);
}

// The same whether printed live or replayed to a late attach.
export function scriptErrorLine(message: string): string {
  return `\r\n\x1b[31m${message}\x1b[0m\r\n`;
}

// Whoever started it, for a window that never saw the start. `interactive`:
// it owns a PTY keystrokes can reach.
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

// Killed because their worktree disappeared from disk; the renderer has
// no other way to explain why a dev server went down.
export const RemovedWorktreeScriptsSchema = Schema.Struct({
  worktreeId: Schema.String,
  worktreeName: Schema.String,
  scriptCount: PositiveInt,
});
export type RemovedWorktreeScripts = typeof RemovedWorktreeScriptsSchema.Type;

// Drained once by the renderer: those runs' consoles died with the
// session that started them.
export const OrphanScriptReportSchema = Schema.Struct({
  stopped: Schema.Natural,
});
export type OrphanScriptReport = typeof OrphanScriptReportSchema.Type;
