// What a quit, a restart into an update or a data-folder move would
// interrupt (the shell's prompt and a peer's refusal word it,
// shared/busy.ts), and what the quit does to the scripts.
import type { BusyOperations } from "@shared/busy";
import * as Effect from "effect/Effect";
import { EngineChanges } from "../Engine";
import { Terminals } from "../terminals/Terminals";
import type { Marks } from "./marks";
import type { Runs } from "./runs";

export const makeUnderWay = ({
  marks,
  runs,
}: {
  readonly marks: Marks;
  readonly runs: Runs;
}) =>
  Effect.gen(function* () {
    const terminals = yield* Terminals;
    const engineChanges = yield* EngineChanges;
    return {
      busy: Effect.map(
        terminals.busy,
        (busyTerminals): BusyOperations => ({
          runningScripts: runs.count(),
          inflightDeletes: marks.removals(),
          inflightMoves: marks.moves(),
          // An engine change on a worktree or project being removed or
          // moved is that removal or move, counted once.
          engineChanges: engineChanges
            .underWay()
            .filter(({ ids }) => !marks.underRemoval(ids))
            .map(({ kind }) => kind),
          busyTerminals,
        }),
      ).pipe(Effect.withSpan("Scripts.busy")),
      // A delete in flight loses its cleanup scripts first, which leaves
      // the worktree directory whole. A hurried quit signals and moves
      // on: an update's installer is waiting on this process to exit, and
      // the data-folder move behind a relaunch has already reaped. A
      // script that ignores the signal may outlive it, which an explicit
      // update accepts.
      quit: (hurried: boolean) =>
        hurried
          ? runs.signalAll
          : Effect.forEach(marks.deleteIds(), runs.stopWorktree, {
              concurrency: "unbounded",
              discard: true,
            }).pipe(Effect.andThen(runs.stopAll({ graceMs: 1_500 }))),
    };
  });
