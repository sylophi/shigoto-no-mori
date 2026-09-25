import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  CancelScriptPayloadSchema,
  OrphanScriptReportSchema,
  RemovedWorktreeScriptsSchema,
  ResizeScriptPayloadSchema,
  RunScriptPayloadSchema,
  ScriptEventSchema,
  WriteScriptPayloadSchema,
} from "@shared/schemas";

export const scriptsContract = defineContract("host", {
  run: invoke(
    "scripts:run",
    RunScriptPayloadSchema,
    z.object({ runId: z.string() }),
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  cancel: invoke(
    "scripts:cancel",
    CancelScriptPayloadSchema,
    z.object({ cancelled: z.boolean() }),
    { remote: true, mutating: true },
  ),
  // Console input and viewport size for a run the app spawned. Both are
  // no-ops for a run with no PTY here (already exited, or a lifecycle
  // script the CLI ran on the app's behalf). The renderer already
  // treats those runs as output-only. Keystrokes change nothing a
  // remote viewer caches (the output comes back over `event`), so
  // they don't ping the viewer cache.
  write: invoke("scripts:write", WriteScriptPayloadSchema, z.void(), {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
  resize: invoke("scripts:resize", ResizeScriptPayloadSchema, z.void(), {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
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
    { remote: true, mutating: false },
  ),
});
