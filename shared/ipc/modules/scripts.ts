import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  CancelScriptPayloadSchema,
  OrphanScriptReportSchema,
  RemovedWorktreeScriptsSchema,
  ResizeScriptPayloadSchema,
  RunScriptPayloadSchema,
  ScriptEventSchema,
  WriteScriptPayloadSchema,
} from "@shared/schemas";

export const scriptsContract = {
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
  // Console input and viewport size for a run the app spawned. Both are
  // no-ops for a run with no PTY here (already exited, or a lifecycle
  // script the CLI ran on the app's behalf). The renderer already
  // treats those runs as output-only.
  write: invoke("scripts:write", WriteScriptPayloadSchema, z.void()),
  resize: invoke("scripts:resize", ResizeScriptPayloadSchema, z.void()),
  event: broadcast("scripts:event", ScriptEventSchema),
  // The worktree these scripts ran in was removed outside the app, so
  // the app reaped them (see main/lib/scripts/removedWorktrees.ts). The
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
} as const;
