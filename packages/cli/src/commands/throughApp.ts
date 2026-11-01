// A worktree's move or rename, made by the running app, which refuses
// it while scripts or terminals it runs are open there and re-opens the
// mirrors rooted there. With no app running nothing runs there, and
// this process makes it. Either way the answer is this engine's row of
// the moved worktree, read once the move is made.
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Control from "../Control.ts";

const throughApp = Effect.fnUntraced(function* <E, R>(
  here: Worktrees.Here,
  located: Worktrees.Located,
  asked: Effect.Effect<{ readonly id: string }, Control.ControlError>,
  inEngine: Effect.Effect<
    { readonly worktree: Worktrees.WorktreeRow; readonly previousId: string },
    E,
    R
  >,
) {
  const worktrees = yield* Worktrees.Worktrees;
  return yield* asked.pipe(
    Effect.flatMap(({ id }) =>
      Effect.gen(function* () {
        const moved = yield* worktrees.resolve(here, {
          projectId: located.project.id,
          worktreeId: id,
        });
        return {
          worktree: yield* worktrees.row(moved),
          previousId: located.worktree.id,
        };
      }),
    ),
    Effect.catchTag("AppNotRunning", () => inEngine),
  );
});

const app = Effect.map(Control.Control, (control) =>
  control.client(worktreesContract),
);

export const moveWorktree = (
  here: Worktrees.Here,
  located: Worktrees.Located,
  destination: string,
) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    return yield* throughApp(
      here,
      located,
      (yield* app).relocate({
        projectId: located.project.id,
        worktreeId: located.worktree.id,
        destinationPath: destination,
      }),
      worktrees.move(located, destination),
    );
  });

export const renameWorktree = (
  here: Worktrees.Here,
  located: Worktrees.Located,
  name: string,
) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    return yield* throughApp(
      here,
      located,
      (yield* app).rename({
        projectId: located.project.id,
        worktreeId: located.worktree.id,
        name,
      }),
      worktrees.rename(located.project, located.worktree.id, name),
    );
  });
