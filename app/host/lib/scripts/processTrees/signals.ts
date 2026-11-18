// Process groups and signals, on a Mac and on Linux: a signal goes to
// the process (its group, when it leads one) and to the descendants
// still reachable by their ppid (one that called setsid() and left the
// group).
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { readDescendants } from "@shigomori/engine/processTable/ps";
import { exitedWithin, type Stop, type Tree } from "./tree";

const SIGNALS = { stop: "SIGTERM", hangup: "SIGHUP" } as const;

function safeKill(pid: number, signal: NodeJS.Signals): void {
  // kill(-1) signals every process the user may signal, kill(0) our
  // own group, kill(1) launchd. No real child or group ever maps to
  // these, so refuse them at the chokepoint every pid source funnels
  // through.
  if (!Number.isInteger(pid) || Math.abs(pid) < 2) return;
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH (no such process) is the common case once the tree is down.
    // EPERM means we lost ownership; nothing we can do either way.
  }
}

export const makeSignals = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const descendantPids = (rootPid: number) =>
    readDescendants(rootPid).pipe(
      Effect.orElseSucceed((): number[] => []),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const signalTree = (pid: number, signal: NodeJS.Signals) =>
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
  const signalPidTree = (pid: number, signal: NodeJS.Signals) =>
    descendantPids(pid).pipe(
      Effect.map((descendants) => {
        safeKill(pid, signal);
        for (const d of descendants) safeKill(d, signal);
      }),
    );

  const send = (tree: Tree, signal: NodeJS.Signals) =>
    tree.ownGroup
      ? signalTree(tree.pid, signal)
      : signalPidTree(tree.pid, signal);

  return {
    stop: Effect.fn("ProcessTrees.stop")(function* (tree: Tree, stop: Stop) {
      yield* send(tree, SIGNALS[stop.how]);
      if (yield* exitedWithin(stop.exited, stop.graceMs)) return true;
      yield* send(tree, "SIGKILL");
      if (yield* exitedWithin(stop.exited, stop.endMs)) return true;
      yield* Effect.logWarning(
        `[scripts] ${stop.name} (pid ${tree.pid}) survived SIGKILL, giving up on it`,
      );
      return false;
    }),
    // A group gets its SIGTERM at once, not after `ps` answers:
    // descendants that escaped it via setsid() get reparented, same as
    // if we hadn't signaled at all.
    stopNow: Effect.fn("ProcessTrees.stopNow")((tree: Tree) =>
      tree.ownGroup
        ? Effect.sync(() => safeKill(-tree.pid, "SIGTERM"))
        : signalPidTree(tree.pid, "SIGTERM"),
    ),
    // The session's end hung up on its group, and node-pty closes the
    // PTY once the shell's output has drained.
    release: () => Effect.void,
  };
});
