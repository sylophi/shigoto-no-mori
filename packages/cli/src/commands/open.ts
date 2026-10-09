// sm [worktrees] open <tool> [<worktree>]: a worktree opened in one of
// its launchers.
import * as Open from "@shigomori/engine/Open";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { UsageError } from "../errors.ts";
import { given, here, projectAt, worktreeFlags } from "../here.ts";
import { pickLauncher, pickWorktree } from "../pickers.ts";
import { interactive } from "../prompt.ts";
import { emit, out, Output } from "../output.ts";

export const open = Command.make(
  "open",
  { ...worktreeFlags, args: Argument.String("args").pipe(Argument.variadic()) },
  (input) =>
    Effect.gen(function* () {
      const { json, binaryName } = yield* Effect.service(Output);
      const [tool = "", name] = input.args;
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
      const asking = yield* interactive;
      const located = Option.isSome(worktreeId)
        ? yield* worktrees.resolve(at, {
            worktreeId: worktreeId.value,
            projectId: Option.getOrUndefined(projectId),
          })
        : name !== undefined
          ? yield* worktrees.resolve(at, {
              ref: name,
              project: Option.getOrUndefined(project),
            })
          : at.current !== undefined && Option.isNone(project)
            ? at.current
            : asking
              ? yield* pickWorktree(
                  at,
                  yield* projectAt(at, Option.getOrUndefined(project)),
                  { primaryOk: true },
                )
              : yield* new UsageError({
                  problem: `Not inside a worktree; pass one: ${binaryName} open <tool> <name>.`,
                });
      if (tool === "" && !asking) {
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
).pipe(Command.withDescription("Open a worktree in a launcher"));
