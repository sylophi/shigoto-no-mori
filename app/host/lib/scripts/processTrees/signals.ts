// Process groups and signals, on a Mac and on Linux: a signal goes to
// the process (its group, when it leads one) and to the descendants
// still reachable by their ppid (one that called setsid() and left the
// group).
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Processes from "@shigomori/engine/processes";
import { descendantsIn } from "../descendants";

type Tree = { readonly pid: number; readonly ownGroup: boolean };

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

  // Walks `ps` to find every process that descends from rootPid via the
  // ppid chain. Catches grandchildren that called setsid() and left our
  // process group. They stay reachable here as long as their ppid hasn't
  // been re-parented to init.
  const descendantPids = (rootPid: number) =>
    Processes.exec("ps", ["-A", "-o", "pid=,ppid="]).pipe(
      Effect.map(({ stdout }) => descendantsIn(stdout, rootPid)),
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
    ask: Effect.fn("ProcessTrees.ask")(
      (tree: Tree, how: keyof typeof SIGNALS) => send(tree, SIGNALS[how]),
    ),
    // Descendants that escaped the group via setsid() get reparented,
    // same as if we hadn't signaled at all.
    askNow: Effect.fn("ProcessTrees.askNow")((tree: Tree) =>
      Effect.sync(() => safeKill(-tree.pid, "SIGTERM")),
    ),
    end: Effect.fn("ProcessTrees.end")((tree: Tree) => send(tree, "SIGKILL")),
    // node-pty closes the PTY once the shell's output has drained.
    release: () => Effect.void,
  };
});
