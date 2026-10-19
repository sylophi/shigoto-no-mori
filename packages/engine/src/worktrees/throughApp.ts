// A worktree's move or rename, made by the running app, which refuses
// it while scripts or terminals it runs are open there and re-opens the
// mirrors rooted there; with no app running nothing runs there, and
// this process makes it. Either way the answer is this engine's row of
// the moved worktree, read once the move is made.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Control from "../Control.ts";
import type { Here, Located } from "./documents.ts";
import * as Worktrees from "../Worktrees.ts";

// The app answers with its own worktree document: only its id is read.
const decodeMoved = Schema.decodeUnknownEffect(
  Schema.Struct({ id: Schema.String }),
);

const throughApp = Effect.fnUntraced(function* <E, R>(
  here: Here,
  located: Located,
  channel: "worktrees:relocate" | "worktrees:rename",
  input: Readonly<Record<string, string>>,
  inEngine: Effect.Effect<
    { readonly worktree: Worktrees.WorktreeRow; readonly previousId: string },
    E,
    R
  >,
) {
  const control = yield* Control.Control;
  const worktrees = yield* Worktrees.Worktrees;
  return yield* control
    .call(channel, {
      projectId: located.project.id,
      worktreeId: located.worktree.id,
      ...input,
    })
    .pipe(
      Effect.flatMap((answer) =>
        Effect.gen(function* () {
          // The same build's answer: a shape it can't read is a defect.
          const { id } = yield* Effect.orDie(decodeMoved(answer));
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

export const moveWorktree = (
  here: Here,
  located: Located,
  destination: string,
) =>
  Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
    throughApp(
      here,
      located,
      "worktrees:relocate",
      { destinationPath: destination },
      worktrees.move(located, destination),
    ),
  );

export const renameWorktree = (here: Here, located: Located, name: string) =>
  Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
    throughApp(
      here,
      located,
      "worktrees:rename",
      { name },
      worktrees.rename(located.project, located.worktree.id, name),
    ),
  );
