// Consoles and process handles, on Windows, which has no process groups
// and no signal a process can catch. A PTY run's tree is attached to a
// pseudoconsole, and closing it is the hangup: node-pty ends every
// process attached to it as it closes it, so a stop and a hangup are one
// and no grace is left to give. What escaped the console, and a tree
// with none (a lifecycle script, or an orphan whose PTY went with its
// host), is ended through the helper.
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { readProcesses } from "@shigomori/engine/processTable/nativefs";
import { exec } from "@shigomori/engine/processes";

type Tree = {
  readonly pid: number;
  readonly closeTerminal?: () => void;
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
          const children = new Map<number, Array<typeof root>>();
          for (const row of table.values()) {
            const siblings = children.get(row.parent);
            if (siblings === undefined) children.set(row.parent, [row]);
            else siblings.push(row);
          }
          const found = [root];
          for (const member of found) {
            found.push(...(children.get(member.pid) ?? []));
          }
          return found;
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
      ask: Effect.fn("ProcessTrees.ask")((tree: Tree) => endTree(tree)),
      // What escaped the console goes on, as a process that left its
      // group does elsewhere.
      askNow: Effect.fn("ProcessTrees.askNow")(close),
      end: Effect.fn("ProcessTrees.end")((tree: Tree) =>
        endTree({ pid: tree.pid }),
      ),
    };
  });
