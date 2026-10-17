// The Worktrees service's moves (../Worktrees.ts): `sm worktrees move`
// and a rename, which the engine commits, held off by the work running
// in the checkout and by the tombstone, with the mirrors rooted in it
// re-opened on its new path after.
import type {
  Project,
  Worktree,
  WorktreeIdentity,
} from "@shigomori/contracts/schemas";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ops from "../engineOps";
import { findProjectAndWorktree } from "../projects";
import * as Scripts from "../Scripts";
import { Terminals } from "../terminals/Terminals";
import { moveMirrorsOfWorktree } from "@host/mirror/registry";
import { RunningWorkError } from "./documents";

export const makeMoving = <H>(host: Context.Context<H>) =>
  Effect.gen(function* () {
    const scripts = yield* Scripts.Scripts;
    const terminals = yield* Terminals;

    const refuseRunningWork = (
      worktree: WorktreeIdentity,
      verb: RunningWorkError["verb"],
    ) => {
      const running = scripts.runningIn(worktree.id);
      const open = terminals.openIn(worktree);
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
        project: Project,
        worktreeId: string,
      ) => Effect.Effect<Worktree, E, R>,
    ) =>
      Effect.gen(function* () {
        const { project, worktree } = yield* findProjectAndWorktree(
          input.projectId,
          input.worktreeId,
        );
        yield* refuseRunningWork(worktree, verb);
        return yield* scripts.withDeleteInflight(
          worktree.id,
          "This worktree is already being removed or moved.",
          commit(project, worktree.id),
          // The engine answers a move to where the worktree already is
          // with its row, under the same id.
          (moved) =>
            moved.id === worktree.id
              ? Effect.void
              : moveMirrorsOfWorktree(worktree.id, moved),
        );
      });

    return {
      relocate: Effect.fn("Worktrees.relocate")(function* (input: {
        readonly projectId: string;
        readonly worktreeId: string;
        readonly destinationPath: string;
      }) {
        return yield* move(input, "move", (project, worktreeId) =>
          Ops.moveWorktree(project, worktreeId, input.destinationPath),
        );
      }, Effect.provide(host)),
      rename: Effect.fn("Worktrees.rename")(function* (input: {
        readonly projectId: string;
        readonly worktreeId: string;
        readonly name: string;
      }) {
        return yield* move(input, "rename", (project, worktreeId) =>
          Ops.renameWorktree(project, worktreeId, input.name),
        );
      }, Effect.provide(host)),
    };
  });
