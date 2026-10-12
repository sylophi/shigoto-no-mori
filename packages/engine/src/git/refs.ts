// Git's refs and objects: resolving a name, reading an object.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { BranchMovedError, UnknownRevisionError } from "./documents.ts";
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

    // The commit `ref` names, or a refusal that says there is none.
    const resolveCommit = Effect.fn("Git.resolveCommit")(function* (
      cwd: string,
      ref: string,
    ) {
      const tip = yield* refTip(cwd, `${ref}^{commit}`);
      if (Option.isNone(tip)) return yield* new UnknownRevisionError({ ref });
      return tip.value;
    });

    const headAt = Effect.fn("Git.headAt")(function* (
      cwd: string,
      expectHead: string | undefined,
    ) {
      const [head, expected] = yield* Effect.all(
        [
          verifyRev(cwd, "HEAD"),
          expectHead ? verifyRev(cwd, expectHead) : Effect.succeed(undefined),
        ],
        { concurrency: 2 },
      );
      if (expected !== undefined && head !== expected) {
        return yield* new BranchMovedError();
      }
      return head;
    });

    const upstreamName = Effect.fn("Git.upstreamName")(function* (cwd: string) {
      return yield* run(cwd, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
      ]).pipe(
        Effect.map((out) => Option.liftPredicate(out.trim(), Boolean)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    });

    const countCommits = Effect.fn("Git.countCommits")(function* (
      cwd: string,
      revs: readonly string[],
      flags: readonly string[] = [],
    ) {
      return Number(
        (yield* run(cwd, [
          "rev-list",
          "--count",
          ...flags,
          "--end-of-options",
          ...revs,
        ])).trim(),
      );
    });

    // Leaves out what any remote has, as unpushedCount does.
    const NOT_ON_A_REMOTE = ["--not", "--remotes", "--not"];

    const ownCommitCounts = Effect.fn("Git.ownCommitCounts")(function* (
      cwd: string,
      ref: string,
    ) {
      const range = [`${ref}..HEAD`];
      return yield* Effect.all(
        {
          own: countCommits(cwd, range),
          merges: countCommits(cwd, range, ["--merges"]),
          unpushed: countCommits(cwd, range, NOT_ON_A_REMOTE),
        },
        { concurrency: "unbounded" },
      );
    });

    return {
      verifyRev,
      refTip,
      hasObject,
      isAncestor,
      resolveCommit,
      headAt,
      upstreamName,
      countCommits,
      ownCommitCounts,
    };
  });

export type RefsArea = Effect.Success<ReturnType<typeof makeRefs>>;
