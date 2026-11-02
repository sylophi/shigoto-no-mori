// The Worktrees service's moves (../Worktrees.ts): `sm worktrees move`
// and a rename, which the engine commits, held off by the work running
// in the checkout and by the tombstone, with the mirrors rooted in it
// re-opened on its new path after. A mirror's copy doesn't move.
import * as EngineWorktrees from "@shigomori/engine/Worktrees";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { asCall, changing } from "../Engine";
import { findProjectAndWorktree, hostWorktree } from "../projects";
import * as Scripts from "../Scripts";
import { Terminals } from "../terminals/Terminals";
import { MirrorLedger } from "@host/mirror/MirrorLedger";
import { MirroredCopyError, RunningWorkError } from "./documents";

export const makeMoving = <H>(host: Context.Context<H>) =>
  Effect.gen(function* () {
    const scripts = yield* Scripts.Scripts;
    const terminals = yield* Terminals;
    const ledger = yield* MirrorLedger;

    const refuseRunningWork = (
      worktree: EngineWorktrees.WorktreeIdentity,
      verb: RunningWorkError["verb"],
    ) => {
      const running = scripts.runningIn(worktree.id);
      const open = terminals.openIn(worktree.id);
      return running + open === 0
        ? Effect.void
        : Effect.fail(
            new RunningWorkError({
              verb,
              name: worktree.name,
              scripts: running,
              terminals: open,
            }),
          );
    };

    // Named by its id or one it had before a move: the id resolved
    // names it from here on.
    const move = <E, R>(
      input: { readonly projectId: string; readonly worktreeId: string },
      verb: RunningWorkError["verb"],
      commit: (
        located: EngineWorktrees.Located,
      ) => Effect.Effect<
        { readonly worktree: EngineWorktrees.WorktreeRow },
        E,
        R
      >,
    ) =>
      Effect.gen(function* () {
        const located = yield* findProjectAndWorktree(
          input.projectId,
          input.worktreeId,
        );
        const { project, worktree } = located;
        // The engine refuses to move the primary checkout, whatever runs
        // in it, so that is what it hears.
        if (!worktree.isPrimary) yield* refuseRunningWork(worktree, verb);
        // A copy is known here by the stream its mirror is served, so a
        // paused mirror's isn't.
        if (ledger.mirrorStreamInto(worktree.id) !== undefined) {
          return yield* new MirroredCopyError({ verb });
        }
        return yield* scripts.withDeletesInflight(
          [worktree.id],
          {
            kind: "move",
            busy: "This worktree is already being removed or moved.",
          },
          asCall(
            changing(
              Effect.map(commit(located), (moved) =>
                hostWorktree(moved.worktree),
              ),
              { projectId: project.id, worktreeId: worktree.id },
              "move",
            ),
          ),
          // A move to where the worktree already is, spelled the same,
          // keeps its id and has no mirrors to carry.
          (moved) =>
            moved.id === worktree.id
              ? Effect.void
              : ledger.moveMirrorsOfWorktree(worktree.id, moved),
        );
      });

    return {
      relocate: Effect.fn("Worktrees.relocate")(function* (input: {
        readonly projectId: string;
        readonly worktreeId: string;
        readonly destinationPath: string;
      }) {
        // `git worktree move`, and what is kept under the worktree's
        // path-derived id (marks, its data, a pending dirty capture)
        // carried to the new one.
        return yield* move(input, "move", (located) =>
          Effect.flatMap(EngineWorktrees.Worktrees, (worktrees) =>
            worktrees.move(located, input.destinationPath),
          ),
        );
      }, Effect.provide(host)),
      rename: Effect.fn("Worktrees.rename")(function* (input: {
        readonly projectId: string;
        readonly worktreeId: string;
        readonly name: string;
      }) {
        return yield* move(input, "rename", ({ project, worktree }) =>
          Effect.flatMap(EngineWorktrees.Worktrees, (worktrees) =>
            worktrees.rename(project, worktree.id, input.name),
          ),
        );
      }, Effect.provide(host)),
    };
  });
