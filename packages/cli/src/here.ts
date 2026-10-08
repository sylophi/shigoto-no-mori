// Where the command runs among the projects, which every command that
// names a project starts from. Terrier's trouble is a warning here, as
// the listing it explains is about to be used.
import * as Terrier from "@shigomori/engine/Terrier";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Flag from "effect/cli/Flag";
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

const here = Effect.gen(function* () {
  yield* warnTerrier;
  // A folder removed under the shell has no cwd, which reads as Go's ".".
  const cwd = yield* Effect.try(() => process.cwd()).pipe(
    Effect.orElseSucceed(() => "."),
  );
  return yield* (yield* Worktrees.Worktrees).here(cwd);
});

// How a command names its project, beside or instead of a positional.
export const projectFlags = {
  project: Flag.String("project").pipe(Flag.withAlias("p"), Flag.optional),
  projectId: Flag.String("project-id").pipe(Flag.optional),
};

// A flag given a value. An empty one is no flag, as in Go.
export const given = (flag: Option.Option<string>) =>
  Option.filter(flag, (value) => value !== "");

// The project a command names: --project-id as the app addresses it,
// else -p or a positional, else the one at the cwd.
export const resolveProject = (ref: {
  readonly projectId: Option.Option<string>;
  readonly project: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const at = yield* here;
    return yield* Option.match(given(ref.projectId), {
      onSome: (projectId) => worktrees.resolveProjectById(at, projectId),
      onNone: () =>
        worktrees.resolveProject(at, Option.getOrUndefined(given(ref.project))),
    });
  });
