import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke, view } from "../contract.ts";
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
  "host",
  invoke(
    "run",
    RunScriptPayloadSchema,
    Schema.Struct({ runId: Schema.String }),
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "runCommands",
    },
  ),
  invoke(
    "cancel",
    CancelScriptPayloadSchema,
    Schema.Struct({ cancelled: Schema.Boolean }),
    { remote: true, gated: true, grant: "runCommands" },
  ),
  // Console input and viewport size for a run the app spawned. Both are
  // no-ops for a run with no PTY here (already exited, or a lifecycle
  // script the engine ran). The renderer already
  // treats those runs as output-only. The output comes back over
  // `event`.
  invoke("write", WriteScriptPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "runCommands",
  }),
  invoke("resize", ResizeScriptPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "runCommands",
  }),
  // Every script running on the host now, for a window that did not
  // see them start (the Live page, a console opened after a reload).
  // A read, so it rides no grant, like mirror:list.
  invoke("list", VoidSchema, RunningScriptsSchema, {
    remote: true,
    gated: false,
  }),
  view("watch", VoidSchema, RunningScriptsSchema, {
    remote: true,
    gated: false,
  }),
  // The set of running scripts changed (one started or ended), on
  // every wire, so a list on screen re-reads. Payload-free like
  // portForward:changed: the list read is cheap.
  broadcast("changed", VoidSchema, { remote: true }),
  // Joins a run this window did not start (another window's or
  // device's, or its own from before a reload): its output so far, and
  // every event from then on over `event`, as if it had started it.
  // Null for a run no longer running. Gated like the console's input:
  // a run's output is as private as its terminal.
  invoke(
    "attach",
    Schema.Struct({ runId: Schema.String }),
    // `streaming`: this connection already heard the run (it started
    // it, or another window on the same connection attached), so its
    // events come once and what the caller buffered of them is in
    // `output` already.
    Schema.NullOr(
      Schema.Struct({ output: Schema.String, streaming: Schema.Boolean }),
    ),
    { remote: true, gated: true, grant: "runCommands" },
  ),
  broadcast("event", ScriptEventSchema, { remote: true }),
  // The worktree these scripts ran in was removed outside the app, so
  // the app reaped them (see host/lib/scripts/removedWorktrees.ts). The
  // run's own console goes away with the worktree row, so this is the
  // only place the stop can still be reported.
  broadcast("stoppedForRemovedWorktree", RemovedWorktreeScriptsSchema, {
    remote: true,
  }),
  // One-shot: the renderer asks once at startup whether the boot sweep
  // stopped anything, so the user hears about dev servers that outlived
  // a crash.
  invoke("orphanReport", VoidSchema, OrphanScriptReportSchema, {
    remote: true,
    gated: false,
  }),
);
