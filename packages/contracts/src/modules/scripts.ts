import * as Schema from "effect/Schema";
import {
  push,
  defineContract,
  invoke,
  view,
  gatedBy,
  ungated,
} from "../contract.ts";
import {
  CancelScriptPayloadSchema,
  OrphanScriptReportSchema,
  RemovedWorktreeScriptsSchema,
  ResizeScriptPayloadSchema,
  RunScriptPayloadSchema,
  RunningScriptsSchema,
  ScriptEventSchema,
  VoidSchema,
  WriteScriptPayloadSchema,
} from "../schemas/index.ts";

export const scriptsContract = defineContract(
  "scripts",
  { scope: "host", version: 1 },
  invoke(
    "run",
    RunScriptPayloadSchema,
    Schema.Struct({ runId: Schema.String }),
    { ...gatedBy("runCommands"), tracksProjectUsage: true },
  ),
  invoke(
    "cancel",
    CancelScriptPayloadSchema,
    Schema.Struct({ cancelled: Schema.Boolean }),
    gatedBy("runCommands"),
  ),
  // No-ops for a run with no PTY here.
  invoke("write", WriteScriptPayloadSchema, VoidSchema, gatedBy("runCommands")),
  invoke(
    "resize",
    ResizeScriptPayloadSchema,
    VoidSchema,
    gatedBy("runCommands"),
  ),
  // Gated: a run's command line is as private as the run.
  invoke("list", VoidSchema, RunningScriptsSchema, gatedBy("runCommands")),
  view("watch", VoidSchema, RunningScriptsSchema, gatedBy("runCommands")),
  // Payload-free: the list read is cheap.
  push("changed", VoidSchema, { remote: true }),
  // Its output so far, then every event as if this window had started it.
  // Gated: a run's output is as private as its terminal.
  invoke(
    "attach",
    Schema.Struct({ runId: Schema.String }),
    // `streaming`: this connection already hears the run, so its events come
    // once and what the caller buffered is in `output` already.
    Schema.NullOr(
      Schema.Struct({ output: Schema.String, streaming: Schema.Boolean }),
    ),
    gatedBy("runCommands"),
  ),
  push("event", ScriptEventSchema, { remote: true }),
  // The run's console went with the worktree row, so this is the only
  // place the stop can be reported.
  push("stoppedForRemovedWorktree", RemovedWorktreeScriptsSchema, {
    remote: true,
  }),
  invoke("orphanReport", VoidSchema, OrphanScriptReportSchema, ungated),
);
