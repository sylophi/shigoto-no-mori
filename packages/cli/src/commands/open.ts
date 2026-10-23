// sm [worktrees] open <tool> [<worktree>]: a worktree opened in one of
// its launchers, and sm [worktrees] edit <file> [<worktree>]: one of its
// files in the editor.
import { resolve } from "node:path";
import { flavorNames } from "@shigomori/engine/flavor";
import * as Open from "@shigomori/engine/Open";
import * as Paths from "@shigomori/engine/Paths";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { UsageError } from "../errors.ts";
import { cwd, given, here, projectAt, rest, worktreeFlags } from "../here.ts";
import { pickLauncher, pickWorktree } from "../pickers.ts";
import { interactive } from "../prompt.ts";
import { emit, out, Output } from "../output.ts";

// The worktree `open` and `edit` act on, from their shared addressing:
// --project-id and --worktree-id exactly, a name after the command's
// first positional, the worktree containing cwd, or menus.
// fromCwd says it was cwd's, which is when a relative path argument
// reads from cwd. usage is the command and its first positional, for
// the error that asks for a name.
const commandTarget = (
  input: {
    readonly worktreeId: Option.Option<string>;
    readonly projectId: Option.Option<string>;
    readonly project: Option.Option<string>;
    readonly args: ReadonlyArray<string>;
  },
  usage: string,
) =>
  Effect.gen(function* () {
    const { binaryName } = yield* Effect.service(Output);
    const name = input.args[1];
    const worktreeId = given(input.worktreeId);
    const projectId = given(input.projectId);
    const project = given(input.project);
    const at = yield* here;
    const worktrees = yield* Worktrees.Worktrees;
    if (Option.isSome(worktreeId) && input.args.length > 1) {
      return yield* new UsageError({
        problem: "Pass either a worktree name or --worktree-id, not both.",
      });
    }
    if (Option.isNone(worktreeId) && Option.isSome(projectId)) {
      return yield* new UsageError({
        problem:
          "--project-id scopes --worktree-id; pass both (or -p <project> with a name).",
      });
    }
    if (Option.isSome(worktreeId)) {
      const located = yield* worktrees.resolve(at, {
        worktreeId: worktreeId.value,
        projectId: Option.getOrUndefined(projectId),
      });
      return { located, fromCwd: false };
    }
    if (name !== undefined) {
      const located = yield* worktrees.resolve(at, {
        ref: name,
        project: Option.getOrUndefined(project),
      });
      return { located, fromCwd: false };
    }
    if (at.current !== undefined && Option.isNone(project)) {
      return { located: at.current, fromCwd: true };
    }
    if (!(yield* interactive)) {
      return yield* new UsageError({
        problem: `Not inside a worktree; pass one: ${binaryName} ${usage} <name>.`,
      });
    }
    const located = yield* pickWorktree(
      at,
      yield* projectAt(at, Option.getOrUndefined(project)),
      { primaryOk: true },
    );
    return { located, fromCwd: false };
  });

export const open = Command.make(
  "open",
  { ...worktreeFlags, args: Argument.String("args").pipe(Argument.variadic()) },
  (input) =>
    Effect.gen(function* () {
      const { json, binaryName } = yield* Effect.service(Output);
      const [tool = ""] = input.args;
      const { located } = yield* commandTarget(input, "open <tool>");
      if (tool === "" && !(yield* interactive)) {
        return yield* new UsageError({
          problem: `Pass a tool to open (see the menu by running \`${binaryName} open\` in a terminal).`,
        });
      }
      const chosen =
        tool === ""
          ? (yield* pickLauncher(located.project, located.worktree.name)).id
          : tool;
      const opened = yield* (yield* Open.Open).open(located, chosen);
      yield* json
        ? emit({
            ok: true,
            launcher: opened.id,
            worktree: located.worktree.name,
          })
        : out(`opened ${opened.label} in ${located.worktree.name}`);
    }),
);

// sm [worktrees] edit <file> [<worktree>]: a worktree's file in the
// editor the settings name, or its default app. A relative path reads
// from cwd when the worktree is cwd's, and from the worktree's root
// when it's named. The app opens a file through Open.edit itself.
export const edit = Command.make(
  "edit",
  { ...worktreeFlags, args: Argument.String("args").pipe(Argument.variadic()) },
  (input) =>
    Effect.gen(function* () {
      const { json, binaryName } = yield* Effect.service(Output);
      const [file = ""] = input.args;
      if (file === "") {
        return yield* new UsageError({
          problem: `Pass a file to edit: ${binaryName} edit <file> [<name>].`,
        });
      }
      const { located, fromCwd } = yield* commandTarget(input, "edit <file>");
      const opened = yield* (yield* Open.Open).edit(
        located,
        fromCwd ? resolve(yield* cwd, file) : file,
      );
      yield* json ? emit({ ok: true, path: opened }) : out(`opened ${opened}`);
    }),
);

// sm app: the installed app, opened or brought forward.
export const app = Command.make("app", { rest }, (input) =>
  Effect.gen(function* () {
    if (input.rest.length > 0) {
      return yield* new UsageError({ problem: "app takes no arguments." });
    }
    yield* (yield* Open.Open).app;
    const { json } = yield* Effect.service(Output);
    const { appName } = flavorNames((yield* Paths.Paths).flavor);
    yield* json ? emit({ ok: true }) : out(`opened ${appName}`);
  }),
);
