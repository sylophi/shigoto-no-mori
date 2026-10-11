// Git's refs and objects: resolving a name, reading an object.
import * as Effect from "effect/Effect";
import type { RunningArea } from "./running.ts";

export const makeRefs = ({ running }: { readonly running: RunningArea }) =>
  Effect.sync(() => {
    const { run, succeeds } = running;
    // --- refs and objects ---
    // Every caller-supplied revision goes after --end-of-options, so none
    // can be read as a flag.

    const verifyRev = Effect.fn("Git.verifyRev")(function* (
      cwd: string,
      rev: string,
    ) {
      return (yield* run(cwd, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        rev,
      ])).trim();
    });

    const refTip = Effect.fn("Git.refTip")(function* (
      cwd: string,
      ref: string,
    ) {
      return yield* Effect.option(verifyRev(cwd, ref));
    });

    const hasObject = Effect.fn("Git.hasObject")(function* (
      cwd: string,
      object: string,
    ) {
      return yield* succeeds(cwd, [
        "cat-file",
        "-e",
        "--end-of-options",
        object,
      ]);
    });

    // merge-base --is-ancestor answers with its exit code: 0 yes, 1 no,
    // anything else a real failure.
    const isAncestor = Effect.fn("Git.isAncestor")(function* (
      cwd: string,
      ancestor: string,
      descendant: string,
    ) {
      return yield* run(cwd, [
        "merge-base",
        "--is-ancestor",
        "--end-of-options",
        ancestor,
        descendant,
      ]).pipe(
        Effect.as(true),
        Effect.catchTags({
          GitCommandError: (error) =>
            error.exitCode === 1 ? Effect.succeed(false) : Effect.fail(error),
        }),
      );
    });

    return { verifyRev, refTip, hasObject, isAncestor };
  });

export type RefsArea = Effect.Success<ReturnType<typeof makeRefs>>;
