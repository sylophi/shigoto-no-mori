// Where the command runs among the projects, which every command that
// names a project starts from. Terrier's trouble is a warning here, as
// the listing it explains is about to be used.
import { isAbsolute, resolve } from "node:path";
import * as Agents from "@shigomori/engine/Agents";
import * as Paths from "@shigomori/engine/Paths";
import * as Terrier from "@shigomori/engine/Terrier";
import { isSameOrInside } from "@shigomori/engine/worktreeLayout";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Flag from "effect/cli/Flag";
import { note, Output, styles } from "./output.ts";
import { noteUnregistered, pickProject, pickWorktree } from "./pickers.ts";
import { interactive } from "./prompt.ts";

// Terrier's trouble, before a command that lists projects.
export const warnTerrier = Effect.gen(function* () {
  const { trouble } = yield* (yield* Terrier.Terrier).listing;
  if (Option.isNone(trouble)) return;
  const { stderrColor } = yield* Effect.service(Output);
  yield* note(
    `${styles(stderrColor).yellow("warning:")} ${trouble.value.summary}.`,
  );
});

// A folder removed under the shell has no cwd, which reads as Go's ".".
export const cwd = Effect.try(() => process.cwd()).pipe(
  Effect.orElseSucceed(() => "."),
);

const where = Effect.gen(function* () {
  yield* warnTerrier;
  return yield* (yield* Worktrees.Worktrees).here(yield* cwd);
});

// Where the command runs. An agent session's shell running sm inside a
// managed worktree binds the session there first (Agents.autoBind),
// except for the `agents` verbs, which change bindings themselves.
export const here = Effect.tap(where, (at) =>
  Effect.flatMap(Effect.service(Agents.Agents), (agents) =>
    agents.autoBind(at),
  ),
);

// How a command names its project, beside or instead of a positional.
export const projectFlags = {
  project: Flag.String("project").pipe(Flag.withAlias("p"), Flag.optional),
  projectId: Flag.String("project-id").pipe(Flag.optional),
};

// A flag given a value. An empty one is no flag, as in Go.
export const given = (flag: Option.Option<string>) =>
  Option.filter(flag, (value) => value !== "");

// The project a command names: --project-id as the app addresses it,
// else -p or a positional, else the one at the cwd. Outside every
// project, a person at a terminal picks one.
export const resolveProject = (ref: {
  readonly projectId: Option.Option<string>;
  readonly project: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const at = yield* here;
    const projectId = given(ref.projectId);
    if (Option.isSome(projectId)) {
      return yield* worktrees.resolveProjectById(at, projectId.value);
    }
    return yield* projectAt(at, Option.getOrUndefined(given(ref.project)));
  });

// The project `ref` names, else the one at the cwd, else (for a person
// at a terminal) the one picked from the menu.
export const projectAt = (at: Worktrees.Here, ref: string | undefined) =>
  Effect.gen(function* () {
    if (ref === undefined && at.current === undefined) {
      const menu = yield* pickedProject(at);
      if (Option.isSome(menu)) return menu.value;
    }
    return yield* (yield* Worktrees.Worktrees).resolveProject(at, ref);
  });

// The project menu, when a person is there to use it.
const pickedProject = (at: Worktrees.Here) =>
  Effect.gen(function* () {
    if (!(yield* interactive) || at.projects.length === 0) {
      return Option.none();
    }
    yield* noteUnregistered(at);
    return Option.some(yield* pickProject(at));
  });

// How a command names its worktree: a name, <project>/<name> or a path
// as the positional, -p to narrow the names, or the app's ids.
export const worktreeFlags = {
  ...projectFlags,
  worktreeId: Flag.String("worktree-id").pipe(Flag.optional),
};

// The worktree a command names, else the one at the cwd, and where the
// command runs. Named by nothing, a person at a terminal picks from a
// menu where Go offers one: outside every worktree, in the primary
// checkout, or with -p naming a project the cwd isn't in. `primaryOk`
// is off for the commands that refuse the primary checkout.
export const resolveWorktree = (
  ref: {
    readonly ref?: Option.Option<string>;
    readonly project: Option.Option<string>;
    readonly projectId: Option.Option<string>;
    readonly worktreeId: Option.Option<string>;
  },
  primaryOk = true,
  autoBind = true,
) =>
  Effect.gen(function* () {
    const at = yield* autoBind ? here : where;
    const worktrees = yield* Worktrees.Worktrees;
    const target = {
      ref: Option.getOrUndefined(given(ref.ref ?? Option.none())),
      project: Option.getOrUndefined(given(ref.project)),
      projectId: Option.getOrUndefined(given(ref.projectId)),
      worktreeId: Option.getOrUndefined(given(ref.worktreeId)),
    };
    const picked =
      target.ref === undefined && target.worktreeId === undefined
        ? yield* pickedWorktree(at, target.project, primaryOk)
        : Option.none();
    const located = Option.isSome(picked)
      ? picked.value
      : yield* worktrees.resolve(at, target);
    return { at, located };
  });

const pickedWorktree = (
  at: Worktrees.Here,
  project: string | undefined,
  primaryOk: boolean,
) =>
  Effect.gen(function* () {
    if (!(yield* interactive)) return Option.none();
    const worktrees = yield* Worktrees.Worktrees;
    if (project !== undefined) {
      const named = yield* worktrees.resolveProject(at, project);
      if (at.current?.project.id !== named.id) {
        return Option.some(yield* pickWorktree(at, named, { primaryOk }));
      }
    }
    if (at.current !== undefined) {
      // From the primary checkout a menu surprises less than acting on
      // it, the primary itself last on it.
      return at.current.worktree.isPrimary
        ? Option.some(
            yield* pickWorktree(at, at.current.project, {
              primaryOk,
              primaryLast: true,
            }),
          )
        : Option.none();
    }
    const chosen = yield* pickedProject(at);
    return Option.isSome(chosen)
      ? Option.some(yield* pickWorktree(at, chosen.value, { primaryOk }))
      : Option.none();
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
// The shell's own $PWD counts, as Go's Getwd prefers it: through a
// symlinked folder it names the path the shell sees.
export const cwdInside = (path: string) => {
  const pwd = process.env.PWD ?? "";
  if (pwd !== "" && isSameOrInside(pwd, path)) return true;
  try {
    return isSameOrInside(process.cwd(), path);
  } catch {
    return false;
  }
};
