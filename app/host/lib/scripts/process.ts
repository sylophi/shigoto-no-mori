// POSIX process-group signaling for the scripts (./pty.ts) and the
// lifecycle scripts the engine runs.
//
// Kill strategy:
//   1. SIGTERM the process group (negative pgid), covering normal forks.
//   2. Walk `ps` for any descendant still reachable via ppid (e.g.
//      double-forked daemons) and SIGTERM those too.
//   3. The caller escalates to SIGKILL through the same path after its
//      grace period.
import * as Effect from "effect/Effect";
import * as Processes from "../util/processes";
import { descendantsIn } from "./descendants";

function safeKill(pid: number, signal: NodeJS.Signals): void {
  // kill(-1) signals every process the user may signal, kill(0) our
  // own group, kill(1) launchd. No real child or group ever maps to
  // these, so refuse them at the chokepoint every pid source funnels
  // through. The persisted-scripts schema rejects pid < 2 too, but
  // a floor here covers future sources as well.
  if (!Number.isInteger(pid) || Math.abs(pid) < 2) return;
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH (no such process) is the common case once the tree is down.
    // EPERM means we lost ownership; nothing we can do either way.
  }
}

// Walks `ps` to find every process that descends from rootPid via the
// ppid chain. Catches grandchildren that called setsid() and left our
// process group. They stay reachable here as long as their ppid hasn't
// been re-parented to init.
const descendantPids = (rootPid: number) =>
  Processes.exec("ps", ["-A", "-o", "pid=,ppid="]).pipe(
    Effect.map(({ stdout }) => descendantsIn(stdout, rootPid)),
    Effect.orElseSucceed((): number[] => []),
  );

// Callers escalate SIGTERM -> grace -> SIGKILL through this same path.
export const signalTree = (pid: number, signal: NodeJS.Signals) =>
  Effect.sync(() => safeKill(-pid, signal)).pipe(
    Effect.andThen(descendantPids(pid)),
    Effect.map((descendants) => {
      for (const d of descendants) safeKill(d, signal);
    }),
  );

// The same for a process that leads no group of its own: a lifecycle
// script the engine ran shares the host's group (a terminal's Ctrl-C
// must reach the whole tree), so stopping it means the pid and its
// descendants, never the group, which would take the host down
// mid-lifecycle.
export const signalPidTree = (pid: number, signal: NodeJS.Signals) =>
  descendantPids(pid).pipe(
    Effect.map((descendants) => {
      safeKill(pid, signal);
      for (const d of descendants) safeKill(d, signal);
    }),
  );

// Synchronous fire-and-forget variant for the update-install quit path,
// where awaiting the kill chain would block the updater's handoff.
// Descendants that escaped the group via setsid() get reparented to
// launchd, same as if we hadn't signaled at all.
export function signalTreeBestEffort(
  pid: number,
  signal: NodeJS.Signals,
): void {
  safeKill(-pid, signal);
}
