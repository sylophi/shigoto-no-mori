// Where the command runs among the projects, which every command that
// names a project starts from. Terrier's trouble is a warning here, as
// the listing it explains is about to be used.
import * as Terrier from "@shigomori/engine/Terrier";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { note, Output, styles } from "./output.ts";

// Terrier's trouble, before a command that lists projects.
export const warnTerrier = Effect.gen(function* () {
  const { trouble } = yield* (yield* Terrier.Terrier).listing;
  if (Option.isNone(trouble)) return;
  const { stderrColor } = yield* Effect.service(Output);
  yield* note(
    `${styles(stderrColor).yellow("warning:")} ${trouble.value.summary}.`,
  );
});

export const here = Effect.gen(function* () {
  yield* warnTerrier;
  return yield* (yield* Worktrees.Worktrees).here(process.cwd());
});

// The project a command names: --project-id as the app addresses it,
// else -p or a positional, else the one at the cwd.
export const resolveProject = (ref: {
  readonly projectId: Option.Option<string>;
  readonly project: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const at = yield* here;
    return Option.isSome(ref.projectId) && ref.projectId.value !== ""
      ? yield* worktrees.resolveProjectById(at, ref.projectId.value)
      : yield* worktrees.resolveProject(at, Option.getOrUndefined(ref.project));
  });
