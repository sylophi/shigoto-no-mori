// The worktree verbs that change things: create, adopt and setup (each
// waits for the lifecycle scripts), rm, move, and rekey for the app.
import { isAbsolute } from "node:path";
import { envVar } from "@shigomori/engine/environment";
import type * as Lifecycle from "@shigomori/engine/Lifecycle";
import { CD_FILE_ENV } from "@shigomori/engine/shellHook";
import * as Agents from "@shigomori/engine/Agents";
import * as Control from "@shigomori/engine/Control";
import type * as Git from "@shigomori/engine/Git";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { ExitCode, UsageError } from "../errors.ts";
import {
  absolute,
  cwdInside,
  given,
  here,
  projectFlags,
  resolveProject,
  resolveWorktree,
  worktreeFlags,
} from "../here.ts";
import { emit, note, out, Output, styles } from "../output.ts";
import { interactive } from "../prompt.ts";
import { reporter } from "../reporter.ts";
import { removeStack } from "./landing.ts";
import { enter } from "./shell.ts";

// A setup script failed, which its own lines said.
class SetupFailed extends Schema.TaggedError<SetupFailed>()("SetupFailed", {
  name: Schema.String,
}) {
  override get message(): string {
    return `setup did not complete cleanly for ${this.name}`;
  }
}

const flag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withDescription(description),
    Flag.withDefault(false),
  );

const force = (description: string) =>
  Flag.Boolean("force").pipe(
    Flag.withAlias("f"),
    Flag.withDescription(description),
    Flag.withDefault(false),
  );

// Go reads the positionals it needs and lets the rest be.
const rest = Argument.String("args").pipe(Argument.variadic());

// Where to go when the shell stands in a folder that is gone: "the
// removed worktree" or "the old location".
const cdNote = (what: string, path: string) =>
  Effect.flatMap(Effect.service(Output), ({ stderrColor }) =>
    note(
      styles(stderrColor).dim(
        `note: your shell is inside ${what}. Run \`cd ${path}\``,
      ),
    ),
  );

// A new worktree's last word: the failed scripts as warnings and the
// path as the result, or the closing document. Exit 3 when a script
// failed, the worktree being there all the same.
const finish = (created: Worktrees.Created) =>
  Effect.gen(function* () {
    const { json, stderrColor } = yield* Effect.service(Output);
    const { worktree, failures } = created;
    if (json) {
      yield* emit({
        event: "done",
        ok: failures.length === 0,
        path: worktree.path,
        worktree,
        failures,
      });
    } else {
      const warning = styles(stderrColor).yellow("warning:");
      yield* Effect.forEach(
        failures,
        ({ step, exitCode }: Lifecycle.ScriptFailure) =>
          note(
            exitCode === null
              ? `${warning} ${step} failed to run`
              : `${warning} ${step} exited with code ${exitCode}`,
          ),
        { discard: true },
      );
      yield* out(worktree.path);
    }
    return failures.length === 0 ? 0 : 3;
  });

export const create = Command.make(
  "create",
  {
    ...projectFlags,
    name: Argument.String("name").pipe(Argument.optional),
    rest,
    branch: Flag.String("branch").pipe(Flag.withAlias("b"), Flag.optional),
    base: Flag.String("base").pipe(Flag.optional),
    checkout: flag("checkout", "Check out the existing branch --base names"),
    noCd: flag("no-cd", "Stay where you are"),
    noSetup: flag("no-setup", "Skip the project's setup script"),
    noClone: flag("no-clone", "Have git write every file"),
  },
  (input) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(input);
      const { json, stderrColor } = yield* Effect.service(Output);
      const { cyan } = styles(stderrColor);
      // An agent session that creates a worktree works in it.
      const agents = yield* Agents.Agents;
      const caller = yield* agents.caller;
      const agentSession = Option.isSome(caller)
        ? yield* agents.starting(caller.value)
        : undefined;
      const created = yield* (yield* Worktrees.Worktrees).create(
        project,
        {
          name: Option.getOrUndefined(given(input.name)),
          branch: Option.getOrUndefined(given(input.branch)),
          base: Option.getOrUndefined(given(input.base)),
          checkout: input.checkout,
          skipSetup: input.noSetup,
          agentSession,
          clone: !input.noClone,
        },
        yield* reporter(
          (worktree) =>
            `created ${cyan(worktree.name)} (branch ${cyan(worktree.branch)})`,
        ),
      );
      const code = yield* finish(created);
      // Into the new worktree, as `sm cd` goes: a subshell, or the
      // caller's own shell through the hook. A failed script's 3 wins
      // over how that shell ends.
      const cdFile = yield* envVar(CD_FILE_ENV);
      if (!input.noCd && !json && ((yield* interactive) || cdFile !== "")) {
        const { name, path } = created.worktree;
        const shell = enter(name, path, cdFile);
        if (code === 0) return yield* shell;
        yield* shell.pipe(
          Effect.catchTags({
            ExitCode: () => Effect.void,
            Killed: () => Effect.void,
          }),
        );
      }
      if (code !== 0) return yield* new ExitCode({ code });
    }),
).pipe(Command.withDescription("Make a new worktree and set it up"));

export const adopt = Command.make(
  "adopt",
  {
    ...worktreeFlags,
    ref: Argument.String("worktree").pipe(Argument.optional),
    rest,
    force: force("Adopt it with uncommitted changes"),
  },
  (input) =>
    Effect.gen(function* () {
      const { located } = yield* resolveWorktree(input, false);
      const { json, stderrColor } = yield* Effect.service(Output);
      const { cyan } = styles(stderrColor);
      const old = located.worktree.path;
      const wasInside = cwdInside(old);
      const created = yield* (yield* Worktrees.Worktrees).adopt(
        located,
        { force: input.force },
        yield* reporter(
          (worktree) =>
            `adopted ${old} as ${cyan(worktree.name)} (branch ${cyan(worktree.branch)})`,
        ),
      );
      const code = yield* finish(created);
      if (wasInside && !json) {
        yield* cdNote("the old location", created.worktree.path);
      }
      if (code !== 0) return yield* new ExitCode({ code });
    }),
).pipe(Command.withDescription("Make an external worktree a managed one"));

export const setup = Command.make(
  "setup",
  {
    ...worktreeFlags,
    ref: Argument.String("worktree").pipe(Argument.optional),
    rest,
  },
  (input) =>
    Effect.gen(function* () {
      const { located } = yield* resolveWorktree(input);
      const { json, stdoutColor, stderrColor } = yield* Effect.service(Output);
      const { ran, failures } = yield* (yield* Worktrees.Worktrees).setup(
        located,
        yield* reporter(),
      );
      if (ran.length === 0) {
        return yield* json
          ? emit({ ok: true, ran: [] })
          : note(
              styles(stderrColor).dim(
                "nothing to run: no setup script configured and port-pool isn't active for this worktree",
              ),
            );
      }
      const ok = failures.length === 0;
      if (json) {
        yield* emit({ ok, ran, failures });
        if (!ok) return yield* new ExitCode({ code: 1 });
        return;
      }
      if (ok) {
        return yield* out(
          styles(stdoutColor).green(
            `setup complete for ${located.worktree.name}`,
          ),
        );
      }
      return yield* new SetupFailed({ name: located.worktree.name });
    }),
).pipe(Command.withDescription("Run a worktree's setup again"));

export const rm = Command.make(
  "rm",
  {
    ...worktreeFlags,
    ref: Argument.String("worktree").pipe(Argument.optional),
    rest,
    force: force("Remove it with uncommitted changes"),
    keepBranch: flag("keep-branch", "Keep its branch"),
    skipCleanup: flag("skip-cleanup", "Skip its teardown and port release"),
    stack: flag("stack", "The worktrees of the landed stack under it too"),
  },
  (input) =>
    Effect.gen(function* () {
      const { located } = yield* resolveWorktree(input, false);
      if (input.stack) {
        return yield* removeStack(located, {
          force: input.force,
          keepBranch: input.keepBranch,
          skipCleanup: input.skipCleanup,
        });
      }
      const { json, stdoutColor } = yield* Effect.service(Output);
      const removed = yield* (yield* Worktrees.Worktrees)
        .remove(
          located,
          {
            force: input.force,
            keepBranch: input.keepBranch,
            skipCleanup: input.skipCleanup,
          },
          yield* reporter(),
        )
        .pipe(
          // The app reads which cleanup step failed from the document.
          Effect.catchTag(
            "CleanupFailed",
            (
              failed,
            ): Effect.Effect<never, Worktrees.CleanupFailed | ExitCode> =>
              json
                ? Effect.andThen(
                    emit({
                      ok: false,
                      cleanupError: Worktrees.cleanupErrorOf(failed),
                    }),
                    Effect.fail(new ExitCode({ code: 1 })),
                  )
                : Effect.fail(failed),
          ),
        );
      // A shell left standing in the removed folder is told where to go.
      const hint = cwdInside(removed.path) ? located.project.path : "";
      if (json) {
        return yield* emit({
          ok: true,
          removed,
          ...(hint === "" ? {} : { cdHint: hint }),
        });
      }
      yield* out(styles(stdoutColor).green(`removed ${removed.name}`));
      if (hint !== "") {
        yield* cdNote("the removed worktree", hint);
      }
    }),
).pipe(Command.withDescription("Remove a worktree, its teardown first"));

type Moved = {
  readonly worktree: { readonly path: string };
  readonly previousId: string;
};

// A move or a rename goes through the running app, which refuses it
// while scripts or terminals it runs are open in the worktree, and
// re-opens the mirrors rooted there. With no app running, nothing runs
// there, and the engine makes it here.
const throughApp = (
  located: Worktrees.Located,
  channel: string,
  input: Record<string, string>,
  inEngine: Effect.Effect<
    Moved,
    Worktrees.WorktreeRefused | Worktrees.UnknownWorktree | Git.GitError
  >,
) =>
  Effect.gen(function* () {
    const control = yield* Control.Control;
    return yield* control
      .call(channel, {
        projectId: located.project.id,
        worktreeId: located.worktree.id,
        ...input,
      })
      .pipe(
        Effect.map(
          (worktree): Moved => ({
            worktree: worktree as Moved["worktree"],
            previousId: located.worktree.id,
          }),
        ),
        Effect.catchTag("AppNotRunning", () => inEngine),
      );
  });

// What a move or a rename prints, and the note for a shell left in the
// old folder.
const reportMoved = (located: Worktrees.Located, moved: Moved) =>
  Effect.gen(function* () {
    const { json } = yield* Effect.service(Output);
    if (json) return yield* emit({ ok: true, ...moved });
    yield* out(moved.worktree.path);
    if (
      cwdInside(located.worktree.path) &&
      moved.worktree.path !== located.worktree.path
    ) {
      yield* cdNote("the old location", moved.worktree.path);
    }
  });

export const move = Command.make(
  "move",
  { ...worktreeFlags, args: Argument.String("args").pipe(Argument.variadic()) },
  (input) =>
    Effect.gen(function* () {
      const { binaryName } = yield* Effect.service(Output);
      // The last positional is where it goes, a name before it.
      const most = Option.isSome(given(input.worktreeId)) ? 0 : 1;
      const count = input.args.length;
      if (count === 0 || count - 1 > most) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} worktrees move [<name>] <new-path>`,
        });
      }
      const destination = yield* absolute(input.args[count - 1] ?? "");
      const { located } = yield* resolveWorktree(
        {
          ...input,
          ref: Option.fromNullishOr(count > 1 ? input.args[0] : undefined),
        },
        false,
      );
      const worktrees = yield* Worktrees.Worktrees;
      yield* reportMoved(
        located,
        yield* throughApp(
          located,
          "worktrees:relocate",
          { destinationPath: destination },
          worktrees.move(located, destination),
        ),
      );
    }),
).pipe(Command.withDescription("Move a worktree's folder"));

export const rename = Command.make(
  "rename",
  { ...worktreeFlags, args: Argument.String("args").pipe(Argument.variadic()) },
  (input) =>
    Effect.gen(function* () {
      const { binaryName } = yield* Effect.service(Output);
      // The last positional is the new name, the worktree's before it.
      const most = Option.isSome(given(input.worktreeId)) ? 0 : 1;
      const count = input.args.length;
      if (count === 0 || count - 1 > most) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} worktrees rename [<name>] <new-name>`,
        });
      }
      const name = input.args[count - 1] ?? "";
      const { located } = yield* resolveWorktree(
        {
          ...input,
          ref: Option.fromNullishOr(count > 1 ? input.args[0] : undefined),
        },
        false,
      );
      const worktrees = yield* Worktrees.Worktrees;
      yield* reportMoved(
        located,
        yield* throughApp(
          located,
          "worktrees:rename",
          { name },
          worktrees.rename(located.project, located.worktree.id, name),
        ),
      );
    }),
).pipe(Command.withDescription("Rename a worktree's folder"));

// The app's plumbing for a folder about to move: what is kept under one
// id carried to the id the new path will have.
export const rekey = Command.make(
  "rekey",
  {
    projectId: projectFlags.projectId,
    fromId: Flag.String("from-id").pipe(Flag.optional),
    toPath: Flag.String("to-path").pipe(Flag.optional),
    rest,
  },
  (input) =>
    Effect.gen(function* () {
      const { binaryName } = yield* Effect.service(Output);
      const projectId = given(input.projectId);
      const fromId = given(input.fromId);
      const toPath = given(input.toPath);
      if (
        Option.isNone(projectId) ||
        Option.isNone(fromId) ||
        Option.isNone(toPath) ||
        input.rest.length > 0
      ) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} worktrees rekey --project-id <id> --from-id <id> --to-path <path>`,
        });
      }
      if (!isAbsolute(toPath.value)) {
        return yield* new UsageError({
          problem: `--to-path must be absolute: ${toPath.value}`,
        });
      }
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* worktrees.resolveProjectById(
        yield* here,
        projectId.value,
      );
      const id = yield* worktrees.rekey(project, fromId.value, toPath.value);
      const { json } = yield* Effect.service(Output);
      yield* json ? emit({ ok: true, id }) : out(id);
    }),
).pipe(Command.withDescription("Carry a worktree's data to its next path"));
