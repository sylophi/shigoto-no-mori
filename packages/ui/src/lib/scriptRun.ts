// A script run's state, as the store keeps it (the app's
// store/scriptRuns.ts) and the status badges and the console draw it.
type RunStatus = "idle" | "starting" | "running" | "exited" | "errored";

export interface ScriptRunState {
  runId: string | null;
  status: RunStatus;
  // Whether any output has arrived. The output itself is a log beside
  // the snapshot (readOutput / subscribeOutput): a render per PTY read
  // would be the hot path, and status UI only needs to know there is
  // something to show or clear.
  hasOutput: boolean;
  // Whether keystrokes reach the process. True for runs the app spawned
  // (they own a PTY in the host), false for lifecycle scripts the engine ran
  // on the app's behalf, which stream output through the same events
  // but have nothing to type into.
  interactive: boolean;
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
  cancelling: boolean;
}

// What the sidebar row shows for a worktree: the slot running there,
// or "failed" for a run that ended badly while its page was not open.
export type ScriptActivityKind = "setup" | "teardown" | "package" | "failed";
