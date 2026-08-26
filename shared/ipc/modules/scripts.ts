import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  CancelScriptPayloadSchema,
  OrphanScriptReportSchema,
  RemovedWorktreeScriptsSchema,
  RunScriptPayloadSchema,
  ScriptEventSchema,
} from "@shared/schemas";

export const scriptsContract = defineContract("host", {
  run: invoke(
    "scripts:run",
    RunScriptPayloadSchema,
    z.object({ runId: z.string() }),
    { tracksProjectUsage: true },
  ),
  cancel: invoke(
    "scripts:cancel",
    CancelScriptPayloadSchema,
    z.object({ cancelled: z.boolean() }),
  ),
  event: broadcast("scripts:event", ScriptEventSchema),
  // The worktree these scripts ran in was removed outside the app, so
  // the app reaped them (see host/lib/scripts/removedWorktrees.ts). The
  // run's own console goes away with the worktree row, so this is the
  // only place the stop can still be reported.
  stoppedForRemovedWorktree: broadcast(
    "scripts:stoppedForRemovedWorktree",
    RemovedWorktreeScriptsSchema,
  ),
  // One-shot: the renderer asks once at startup whether the boot sweep
  // stopped anything, so the user hears about dev servers that outlived
  // a crash.
  orphanReport: invoke(
    "scripts:orphanReport",
    z.void(),
    OrphanScriptReportSchema,
  ),
});
