import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  CancelScriptPayloadSchema,
  OrphanScriptReportSchema,
  RemovedWorktreeScriptsSchema,
  ResizeScriptPayloadSchema,
  RunScriptPayloadSchema,
  RunningScriptsSchema,
  ScriptEventSchema,
  WriteScriptPayloadSchema,
} from "@shared/schemas";

export const scriptsContract = defineContract("host", {
  run: invoke(
    "scripts:run",
    RunScriptPayloadSchema,
    z.object({ runId: z.string() }),
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  cancel: invoke(
    "scripts:cancel",
    CancelScriptPayloadSchema,
    z.object({ cancelled: z.boolean() }),
    { remote: true, gated: true },
  ),
  // Console input and viewport size for a run the app spawned. Both are
  // no-ops for a run with no PTY here (already exited, or a lifecycle
  // script the CLI ran on the app's behalf). The renderer already
  // treats those runs as output-only. Keystrokes change nothing a
  // remote viewer caches (the output comes back over `event`), so
  // they don't ping the viewer cache.
  write: invoke("scripts:write", WriteScriptPayloadSchema, z.void(), {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  resize: invoke("scripts:resize", ResizeScriptPayloadSchema, z.void(), {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  // Every script running on the host now, for a window that did not
  // see them start (the Live page, a console opened after a reload).
  // A read, so it rides no grant, like mirror:list.
  list: invoke("scripts:list", z.void(), RunningScriptsSchema, {
    remote: true,
    gated: false,
  }),
  // The set of running scripts changed (one started or ended), on
  // every wire, so a list on screen re-reads. Payload-free like
  // portForward:changed: the list read is cheap.
  changed: broadcast("scripts:changed", z.void(), { remote: true }),
  // Joins a run this window did not start (another window's or
  // device's, or its own from before a reload): its output so far, and
  // every event from then on over `event`, as if it had started it.
  // Null for a run no longer running. Gated like the console's input:
  // a run's output is as private as its terminal.
  attach: invoke(
    "scripts:attach",
    z.object({ runId: z.string() }),
    // `streaming`: this connection already heard the run (it started
    // it, or another window on the same connection attached), so its
    // events come once and what the caller buffered of them is in
    // `output` already.
    z.object({ output: z.string(), streaming: z.boolean() }).nullable(),
    { remote: true, gated: true, movesHostState: false },
  ),
  event: broadcast("scripts:event", ScriptEventSchema, { remote: true }),
  // The worktree these scripts ran in was removed outside the app, so
  // the app reaped them (see host/lib/scripts/removedWorktrees.ts). The
  // run's own console goes away with the worktree row, so this is the
  // only place the stop can still be reported.
  stoppedForRemovedWorktree: broadcast(
    "scripts:stoppedForRemovedWorktree",
    RemovedWorktreeScriptsSchema,
    { remote: true },
  ),
  // One-shot: the renderer asks once at startup whether the boot sweep
  // stopped anything, so the user hears about dev servers that outlived
  // a crash.
  orphanReport: invoke(
    "scripts:orphanReport",
    z.void(),
    OrphanScriptReportSchema,
    { remote: true, gated: false },
  ),
});
