import * as Open from "@shigomori/engine/Open";
import * as Effect from "effect/Effect";
import { Terminals } from "./Terminals";

// An open whose terminal tool runs in the worktree's terminal here
// (Open.AppTerminal), with that terminal's id for the window to show it.
export const inAppTerminal = <E, R>(open: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    const terminals = yield* Terminals;
    let terminalId: string | undefined;
    yield* open.pipe(
      Effect.provideService(Open.AppTerminal, {
        run: ({ project, worktree }, command) =>
          Effect.map(
            terminals.open({
              worktree: { projectId: project.id, worktreeId: worktree.id },
              command,
            }),
            (terminal) => {
              terminalId = terminal.terminalId;
            },
          ),
      }),
    );
    return { terminalId };
  });
