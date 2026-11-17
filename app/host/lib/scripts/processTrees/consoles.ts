// Consoles and process handles, on Windows, which has no process groups
// and no signal a process can catch. A PTY run's tree is attached to a
// pseudoconsole. A stop is the Ctrl+C typed into it, which every process
// on the console hears, and closing it is the hangup, which ends what is
// still attached. A tree is its root and everything on the root's
// console, with all they started: what Git Bash forks and execs runs
// with its parent gone, on the console all the same. A lifecycle script's
// root is the helper that holds it in a job (nativefs job), whose end
// ends everything in the job. One on the host's own console is only its
// root and what that started. What escaped the console, and a tree with
// none (an orphan whose PTY went with its host), is ended through the
// helper.
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { readProcesses } from "@shigomori/engine/processTable/nativefs";
import { exec } from "@shigomori/engine/processes";
import { exitedWithin, type Stop, type Tree } from "./tree";

const close = (tree: Tree) =>
  Effect.try(() => tree.terminal?.close()).pipe(Effect.ignore);

export const makeConsoles = (nativefs: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // The tree under `pid` as it is now, each process with its birth.
    // Read before the console closes, while the shell that holds it
    // together still runs.
    const members = (pid: number) =>
      readProcesses(nativefs).pipe(
        Effect.map((table) => {
          const root = table.get(pid);
          if (root === undefined) return [];
          const own = table.get(process.pid)?.console;
          const children = new Map<number, Array<typeof root>>();
          for (const row of table.values()) {
            const siblings = children.get(row.parent);
            if (siblings === undefined) children.set(row.parent, [row]);
            else siblings.push(row);
          }
          const found = new Map([[root.pid, root]]);
          if (root.console !== undefined && root.console !== own) {
            for (const row of table.values()) {
              if (row.console === root.console) found.set(row.pid, row);
            }
          }
          for (const member of found.values()) {
            for (const child of children.get(member.pid) ?? []) {
              found.set(child.pid, child);
            }
          }
          return [...found.values()];
        }),
        Effect.orElseSucceed(() => []),
      );

    const end = (found: ReadonlyArray<{ pid: number; birth: number }>) =>
      found.length === 0
        ? Effect.void
        : exec(nativefs, [
            "end",
            ...found.map((member) => `${member.pid}:${member.birth}`),
          ]).pipe(Effect.ignore);

    // Closes the console and ends the rest of the tree.
    const endTree = (tree: Tree) =>
      Effect.gen(function* () {
        const found = yield* members(tree.pid);
        yield* close(tree);
        yield* end(found);
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    // The same once the console is closed.
    const endAgain = (tree: Tree) =>
      members(tree.pid).pipe(
        Effect.flatMap(end),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    return {
      stop: Effect.fn("ProcessTrees.stop")(function* (tree: Tree, stop: Stop) {
        if (stop.how === "stop" && tree.terminal !== undefined) {
          yield* Effect.try(tree.terminal.interrupt).pipe(Effect.ignore);
          if (yield* exitedWithin(stop.exited, stop.graceMs)) {
            yield* close(tree);
            return true;
          }
        }
        yield* endTree(tree);
        if (yield* exitedWithin(stop.exited, stop.graceMs)) return true;
        // The first end may not have finished the tree: a table read that
        // failed finds nothing, and an end that failed says nothing.
        yield* endAgain(tree);
        if (yield* exitedWithin(stop.exited, stop.endMs)) return true;
        yield* Effect.logWarning(
          `[scripts] ${stop.name} (pid ${tree.pid}) still runs after its tree was ended, giving up on it`,
        );
        return false;
      }),
      // A PTY run's console closes without reading the table: what
      // escaped the console goes on, as a process that left its group
      // does elsewhere.
      stopNow: Effect.fn("ProcessTrees.stopNow")((tree: Tree) =>
        tree.terminal === undefined ? endTree(tree) : close(tree),
      ),
      // The console outlives its shell (the node-pty patch), and closing
      // it ends what is still attached.
      release: Effect.fn("ProcessTrees.release")(close),
    };
  });
