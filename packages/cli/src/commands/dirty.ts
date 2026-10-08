// sm [worktrees] dirty <capture|apply> [<worktree>] [-f]: a worktree's
// uncommitted state captured as a commit, and applied back.
import * as Dirty from "@shigomori/engine/Dirty";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { resolveWorktree, worktreeFlags } from "../here.ts";
import { emit, out, Output, styles } from "../output.ts";

export const dirty = Command.make(
  "dirty",
  {
    ...worktreeFlags,
    args: Argument.String("args").pipe(Argument.variadic()),
    force: Flag.Boolean("force").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Apply over uncommitted changes"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const { json, binaryName, stdoutColor } = yield* Effect.service(Output);
      const [verb, ref] = input.args;
      if (verb !== "capture" && verb !== "apply") {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} dirty <capture|apply> [<name>] [-f]`,
        });
      }
      const { project, worktree } = (yield* resolveWorktree({
        ...input,
        ref: Option.fromNullishOr(ref),
      })).located;
      const target = {
        projectPath: project.path,
        worktreePath: worktree.path,
        worktreeId: worktree.id,
      };
      const service = yield* Dirty.Dirty;
      const { green } = styles(stdoutColor);
      if (verb === "capture") {
        const captured = yield* service.capture(target);
        if (json) return yield* emit({ ok: true, ...captured });
        return yield* out(
          captured.captured
            ? green(
                `captured ${captured.changedFiles} change(s) from ${worktree.name}`,
              )
            : `nothing to capture -- ${worktree.name} is clean`,
        );
      }
      const applied = yield* service.apply(target, { force: input.force });
      yield* json
        ? emit({ ok: true, applied: true, ...applied })
        : out(
            green(
              `applied ${applied.changedFiles} change(s) to ${worktree.name}`,
            ),
          );
    }),
).pipe(
  Command.withDescription("Capture or apply a worktree's uncommitted state"),
);
