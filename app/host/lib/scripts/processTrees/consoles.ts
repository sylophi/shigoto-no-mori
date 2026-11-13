// Consoles and process handles, on Windows, which has no process groups
// and no signal a process can catch. A PTY run's tree is attached to a
// pseudoconsole, and closing it is the hangup: node-pty ends every
// process attached to it as it closes it, so a stop and a hangup are one
// and no grace is left to give. A process that made a console of its
// own, or went without one, is out of the console's reach, and is
// ended with the rest through the helper (nativefs/processes_windows.go),
// which ends a pid only while it names the process born when the table
// was read. A lifecycle script, or an orphan whose PTY went with its
// host, has no console to close, so asking it is ending it.
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { readProcesses } from "@shigomori/engine/processTable/nativefs";
import { exec } from "@shigomori/engine/processes";

type Tree = {
  readonly pid: number;
  readonly closeTerminal?: () => void;
};

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
          const found = [root];
          for (let i = 0; i < found.length; i++) {
            const parent = found[i]?.pid;
            for (const row of table.values()) {
              if (row.parent === parent) found.push(row);
            }
          }
          return found;
        }),
        Effect.orElseSucceed(() => []),
      );

    const endTree = (pid: number, closeTerminal?: () => void) =>
      Effect.gen(function* () {
        const tree = yield* members(pid);
        if (closeTerminal !== undefined) {
          yield* Effect.try(closeTerminal).pipe(Effect.ignore);
        }
        if (tree.length === 0) return;
        yield* exec(nativefs, [
          "end",
          ...tree.map((member) => `${member.pid}:${member.birth}`),
        ]).pipe(Effect.ignore);
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    return {
      ask: Effect.fn("ProcessTrees.ask")((tree: Tree) =>
        endTree(tree.pid, tree.closeTerminal),
      ),
      // node-pty ends what is attached to the console. What escaped it
      // goes on, as a process that left its group does elsewhere.
      askNow: Effect.fn("ProcessTrees.askNow")((tree: Tree) =>
        Effect.try(() => tree.closeTerminal?.()).pipe(Effect.ignore),
      ),
      end: Effect.fn("ProcessTrees.end")((tree: Tree) => endTree(tree.pid)),
    };
  });
