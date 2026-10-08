// Where the command runs among the projects, which every command that
// names a project starts from. Terrier's trouble is a warning here, as
// the listing it explains is about to be used.
import { isAbsolute, resolve } from "node:path";
import * as Paths from "@shigomori/engine/Paths";
import * as Terrier from "@shigomori/engine/Terrier";
import { isSameOrInside } from "@shigomori/engine/worktreeLayout";
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

export const here = Effect.gen(function* () {
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

// How a command names its worktree: a name, <project>/<name> or a path
// as the positional, -p to narrow the names, or the app's ids.
export const worktreeFlags = {
  ...projectFlags,
  worktreeId: Flag.String("worktree-id").pipe(Flag.optional),
};

// The worktree a command names, else the one at the cwd, and where the
// command runs.
export const resolveWorktree = (ref: {
  readonly ref?: Option.Option<string>;
  readonly project: Option.Option<string>;
  readonly projectId: Option.Option<string>;
  readonly worktreeId: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const at = yield* here;
    const located = yield* (yield* Worktrees.Worktrees).resolve(at, {
      ref: Option.getOrUndefined(given(ref.ref ?? Option.none())),
      project: Option.getOrUndefined(given(ref.project)),
      projectId: Option.getOrUndefined(given(ref.projectId)),
      worktreeId: Option.getOrUndefined(given(ref.worktreeId)),
    });
    return { at, located };
  });

// A typed path, home-expanded and made absolute against the cwd, as
// Go's toAbsolute: an absolute path stays as typed, and without a cwd
// the path stays relative.
export const absolute = (raw: string) =>
  Effect.map(Effect.service(Paths.Paths), ({ expandHome }) => {
    const expanded = expandHome(raw);
    if (isAbsolute(expanded)) return expanded;
    try {
      return resolve(process.cwd(), expanded);
    } catch {
      return expanded;
    }
  });

// Whether the command runs at or below `path`: the shell a removal or a
// move leaves standing in a folder that is gone.
export const cwdInside = (path: string) => {
  try {
    return isSameOrInside(process.cwd(), path);
  } catch {
    return false;
  }
};
