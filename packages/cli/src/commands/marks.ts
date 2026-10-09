// sm [worktrees] shelve|unshelve [<worktree>]: the app's "out of focus"
// flag. sm autopull [on|off] [<worktree>]: the app's auto-pull mark,
// shown without on or off.
import * as Registry from "@shigomori/engine/Registry";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { UsageError } from "../errors.ts";
import { resolveWorktree, worktreeFlags } from "../here.ts";
import { emit, out, Output, styles } from "../output.ts";

const shelf = (name: "shelve" | "unshelve") =>
  Command.make(
    name,
    {
      ...worktreeFlags,
      ref: Argument.String("worktree").pipe(Argument.optional),
      // Go reads the first and lets the rest be.
      rest: Argument.String("args").pipe(Argument.variadic()),
    },
    (input) =>
      Effect.gen(function* () {
        const shelved = name === "shelve";
        const { worktree } = (yield* resolveWorktree(input, false)).located;
        yield* (yield* Worktrees.Worktrees).setShelved(worktree, shelved);
        const { json, stdoutColor } = yield* Effect.service(Output);
        yield* json
          ? emit({ ok: true, name: worktree.name, id: worktree.id, shelved })
          : out(
              styles(stdoutColor).green(
                `${shelved ? "shelved" : "unshelved"} ${worktree.name}`,
              ),
            );
      }),
  ).pipe(
    Command.withDescription(
      name === "shelve"
        ? "Put a worktree out of focus"
        : "Bring a worktree back into focus",
    ),
  );

export const shelve = shelf("shelve");
export const unshelve = shelf("unshelve");

// The auto-pull mark: set with on or off, shown without.
const name = "autopull";
const label = "auto-pull";

export const autopull = Command.make(
  name,
  {
    ...worktreeFlags,
    args: Argument.String("args").pipe(Argument.variadic()),
  },
  (input) =>
    Effect.gen(function* () {
      const [first, ...rest] = input.args;
      const mode = first === "on" || first === "off" ? first : undefined;
      const names = mode === undefined ? input.args : rest;
      const { json, stdoutColor, binaryName } = yield* Effect.service(Output);
      if (names.length > 1) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} ${name} [on|off] [<name>]`,
        });
      }
      const worktrees = yield* Worktrees.Worktrees;
      const located = (yield* resolveWorktree({
        ...input,
        ref: Option.fromNullishOr(names[0]),
      })).located;
      if (mode !== undefined) {
        yield* worktrees.setAutoPull(located.worktree, mode === "on");
      }
      if (json) {
        return yield* emit({
          ok: true,
          worktree: yield* worktrees.row(located),
        });
      }
      const { name: worktree } = located.worktree;
      if (mode !== undefined) {
        return yield* out(
          styles(stdoutColor).green(`${label} ${mode} for ${worktree}`),
        );
      }
      // The stored mark, without probing the checkout.
      const marked = yield* (yield* Registry.Registry).marked("autoPull");
      yield* out(
        `${worktree}: ${label} ${marked.has(located.worktree.id) ? "on" : "off"}`,
      );
    }),
).pipe(Command.withDescription(`Set or show a worktree's ${label} mark`));
