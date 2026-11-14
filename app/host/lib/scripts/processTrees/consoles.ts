// Consoles and process handles, on Windows, which has no process groups
// and no signal a process can catch. A PTY run's tree is attached to a
// pseudoconsole. A stop is the Ctrl+C typed into it, which every process
// on the console hears, and closing it is the hangup, which ends what is
// still attached. A tree is its root and everything on the root's
// console, with all they started: what Git Bash forks and execs runs
// with its parent gone, on the console all the same. A lifecycle script
// has a console of its own as well, as a hidden child is given one. One
// on the host's own console is only its root and what that started.
// What escaped the console, and a tree with none (a lifecycle script, or
// an orphan whose PTY went with its host), is ended through the helper.
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { readProcesses } from "@shigomori/engine/processTable/nativefs";
import { exec } from "@shigomori/engine/processes";

type Tree = {
  readonly pid: number;
  readonly closeTerminal?: () => void;
  readonly interrupt?: () => void;
};

const close = (tree: Tree) =>
  Effect.try(() => tree.closeTerminal?.()).pipe(Effect.ignore);

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

    const endTree = (tree: Tree) =>
      Effect.gen(function* () {
        const found = yield* members(tree.pid);
        yield* close(tree);
        if (found.length === 0) return;
        yield* exec(nativefs, [
          "end",
          ...found.map((member) => `${member.pid}:${member.birth}`),
        ]).pipe(Effect.ignore);
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    return {
      ask: Effect.fn("ProcessTrees.ask")((tree: Tree, how: "stop" | "hangup") =>
        how === "stop" && tree.interrupt !== undefined
          ? Effect.try(tree.interrupt).pipe(Effect.ignore)
          : endTree(tree),
      ),
      // What escaped the console goes on, as a process that left its
      // group does elsewhere.
      askNow: Effect.fn("ProcessTrees.askNow")(close),
      end: Effect.fn("ProcessTrees.end")(endTree),
      release: Effect.fn("ProcessTrees.release")(close),
    };
  });
