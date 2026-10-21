// Where the command runs among the projects, which every command that
// names a project starts from. Terrier's trouble is a warning here, as
// the listing it explains is about to be used.
import { isAbsolute, resolve } from "node:path";
import * as Agents from "@shigomori/engine/Agents";
import * as Paths from "@shigomori/engine/Paths";
import * as Terrier from "@shigomori/engine/Terrier";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Flag from "effect/cli/Flag";
import { unlessUnmigrated } from "./errors.ts";
import { note, Output, styles } from "./output.ts";
import { noteUnregistered, pickProject, pickWorktree } from "./pickers.ts";
import { interactive } from "./prompt.ts";

const warning = Effect.gen(function* () {
  const { trouble } = yield* (yield* Terrier.Terrier).listing;
  if (Option.isNone(trouble)) return;
  const { stderrColor } = yield* Effect.service(Output);
  yield* note(
    `${styles(stderrColor).yellow("warning:")} ${trouble.value.summary}.`,
  );
});

// A folder removed under the shell has no cwd, which reads as ".".
export const cwd = Effect.try(() => process.cwd()).pipe(
  Effect.orElseSucceed(() => "."),
);

const where = Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
  Effect.flatMap(cwd, worktrees.here),
);

// Where this run of sm is, and terrier's trouble said, each once
// however many ask (layer).
export class Here extends Context.Service<
  Here,
  { readonly at: typeof where; readonly warned: typeof warning }
>()("sm/cli/Here") {}

export const layer = Layer.effect(
  Here,
  Effect.gen(function* () {
    return Here.of({
      at: yield* Effect.cached(where),
      warned: yield* Effect.cached(warning),
    });
  }),
);

// Terrier's trouble, before a command that lists projects.
export const warnTerrier = Effect.flatMap(
  Effect.service(Here),
  ({ warned }) => warned,
);

export const here = Effect.flatMap(Effect.service(Here), ({ at, warned }) =>
  Effect.andThen(warned, at),
);

// An agent session's shell running sm inside a managed worktree binds
// the session there (Agents.autoBind), before any command that reads
// where it runs: all but `agents`, which change bindings themselves,
// and the ones that need no projects (main.ts).
export const bindCaller = Effect.gen(function* () {
  const agents = yield* Agents.Agents;
  if (Option.isNone(yield* agents.caller)) return;
  yield* agents.autoBind(yield* here);
}).pipe(unlessUnmigrated);

// How a command names its project, beside or instead of a positional.
export const projectFlags = {
  project: Flag.String("project").pipe(Flag.withAlias("p"), Flag.optional),
  projectId: Flag.String("project-id").pipe(Flag.optional),
};

// The positionals past the ones a command reads, let be.
export const rest = Argument.String("args").pipe(Argument.variadic());

// A flag given a value. An empty one is no flag.
export const given = (flag: Option.Option<string>) =>
  Option.filter(flag, (value) => value !== "");

// The project a command names: --project-id as the app addresses it,
// else -p or a positional, else the one at the cwd (the engine's
// `resolveProjectRef`). Outside every project, a person at a terminal
// picks one.
export const resolveProject = (ref: {
  readonly projectId: Option.Option<string>;
  readonly project: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const at = yield* here;
    return yield* (yield* Worktrees.Worktrees)
      .resolveProjectRef(at, {
        projectId: Option.getOrUndefined(ref.projectId),
        project: Option.getOrUndefined(ref.project),
      })
      .pipe(orPickedProject(at));
  });

// The project `ref` names, else the one at the cwd, else (for a person
// at a terminal) the one picked from the menu.
export const projectAt = (at: Worktrees.Here, ref: string | undefined) =>
  Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
    worktrees.resolveProject(at, ref),
  ).pipe(orPickedProject(at));

// The engine refuses a command that names no project outside every
// project. A person at a terminal picks one instead.
const orPickedProject =
  (at: Worktrees.Here) =>
  <A, E, R>(resolved: Effect.Effect<A, E | Worktrees.TargetError, R>) =>
    Effect.catchIf(
      resolved,
      (error): error is Worktrees.TargetError =>
        error instanceof Worktrees.TargetError &&
        (error.reason === "not-in-project" ||
          error.reason === "unregistered-project"),
      (refused) => pickedProject(at, refused),
    );

// The project menu in place of the engine's refusal, when a person is
// there to use it.
const pickedProject = (at: Worktrees.Here, refused: Worktrees.TargetError) =>
  Effect.gen(function* () {
    if (!(yield* interactive) || at.projects.length === 0) {
      return yield* refused;
    }
    yield* noteUnregistered(at);
    return yield* pickProject(at);
  });

// How a command names its worktree: a name, <project>/<name> or a path
// as the positional, -p to narrow the names, or the app's ids.
export const worktreeFlags = {
  ...projectFlags,
  worktreeId: Flag.String("worktree-id").pipe(Flag.optional),
};

// The worktree a command names, else the one at the cwd, and where the
// command runs. Named by nothing, a person at a terminal picks from a
// menu: in place of the engine's refusal (outside every worktree, or
// with -p naming a project the cwd isn't in), and in the primary
// checkout. `primaryOk` is off for the commands that refuse the primary
// checkout.
export const resolveWorktree = (
  ref: {
    readonly ref?: Option.Option<string>;
    readonly project: Option.Option<string>;
    readonly projectId: Option.Option<string>;
    readonly worktreeId: Option.Option<string>;
  },
  primaryOk = true,
) =>
  Effect.gen(function* () {
    const at = yield* here;
    const worktrees = yield* Worktrees.Worktrees;
    const target = {
      ref: Option.getOrUndefined(given(ref.ref ?? Option.none())),
      project: Option.getOrUndefined(given(ref.project)),
      projectId: Option.getOrUndefined(given(ref.projectId)),
      worktreeId: Option.getOrUndefined(given(ref.worktreeId)),
    };
    const resolved = worktrees.resolve(at, target);
    if (
      target.ref !== undefined ||
      target.worktreeId !== undefined ||
      !(yield* interactive)
    ) {
      return { at, located: yield* resolved };
    }
    const located = yield* resolved.pipe(
      Effect.matchEffect({
        // From the primary checkout a menu surprises less than acting on
        // it, the primary itself last on it.
        onSuccess: (current) =>
          current.worktree.isPrimary
            ? pickWorktree(at, current.project, {
                primaryOk,
                primaryLast: true,
              })
            : Effect.succeed(current),
        onFailure: (refused) => {
          if (!(refused instanceof Worktrees.TargetError)) {
            return Effect.fail(refused);
          }
          if (refused.reason === "name-in-project") {
            return Effect.flatMap(
              worktrees.resolveProject(at, target.project),
              (project) => pickWorktree(at, project, { primaryOk }),
            );
          }
          return refused.reason === "not-in-worktree" ||
            refused.reason === "unregistered-worktree"
            ? Effect.flatMap(pickedProject(at, refused), (project) =>
                pickWorktree(at, project, { primaryOk }),
              )
            : Effect.fail(refused);
        },
      }),
    );
    return { at, located };
  });

// A typed path, home-expanded and made absolute against the cwd: an
// absolute path stays as typed, and without a cwd the path stays
// relative.
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
// The shell's own $PWD counts too: through a symlinked folder it
// names the path the shell sees.
export const cwdInside = (path: string) => {
  const pwd = process.env.PWD ?? "";
  if (pwd !== "" && isSameOrInside(pwd, path)) return true;
  try {
    return isSameOrInside(process.cwd(), path);
  } catch {
    return false;
  }
};
