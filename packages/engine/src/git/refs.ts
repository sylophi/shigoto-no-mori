// Git's refs and objects: resolving a name, reading an object, writing a ref.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { canonicalPath } from "../canonicalPath.ts";
import { splitLines } from "../gitParse.ts";
import {
  BranchMovedError,
  GitCommandError,
  LOCAL_TIPS_LIMIT,
  RefUnreadable,
  UnknownRevisionError,
} from "./documents.ts";
import type { RunningArea } from "./running.ts";

export const makeRefs = ({ running }: { readonly running: RunningArea }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { run, succeeds } = running;
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

    // A ref's commit, none when it isn't there, and a failure when git
    // can't tell: only `--verify --quiet`'s exit 1 means missing (a
    // packed-refs git can't parse exits otherwise), and even then git
    // answers a ref it can't open as missing, so its loose file still
    // there, or a packed-refs it can't read, says it is not.
    const readRef = Effect.fn("Git.readRef")(function* (
      cwd: string,
      ref: string,
    ) {
      const found = yield* run(cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        ref,
      ]).pipe(
        Effect.map((out) => Option.some(out.trim())),
        Effect.catchIf(
          (error) => error instanceof GitCommandError && error.exitCode === 1,
          () => Effect.succeed(Option.none<string>()),
        ),
      );
      if (Option.isSome(found)) return found;
      const [loose = "", packed = ""] = (yield* run(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        ref,
        "--git-path",
        "packed-refs",
      ]))
        .split("\n")
        .map(canonicalPath);
      const unreadable =
        (yield* fs.exists(loose).pipe(Effect.orElseSucceed(() => true))) ||
        ((yield* fs.exists(packed).pipe(Effect.orElseSucceed(() => true))) &&
          !(yield* fs
            .access(packed, { readable: true })
            .pipe(Effect.isSuccess)));
      if (unreadable) return yield* new RefUnreadable({ ref });
      return Option.none<string>();
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
          expectHead ? verifyRev(cwd, expectHead) : Effect.void,
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

    const treeOf = Effect.fn("Git.treeOf")(function* (
      cwd: string,
      commit: string,
    ) {
      return yield* verifyRev(cwd, `${commit}^{tree}`);
    });

    const hasCommit = Effect.fn("Git.hasCommit")(function* (
      cwd: string,
      commit: string,
    ) {
      return yield* hasObject(cwd, `${commit}^{commit}`);
    });

    const updateRef = Effect.fn("Git.updateRef")(function* (input: {
      readonly repo: string;
      readonly ref: string;
      readonly commit: string;
      readonly expected?: string | undefined;
    }) {
      yield* run(input.repo, [
        "update-ref",
        "--end-of-options",
        input.ref,
        input.commit,
        ...(input.expected === undefined ? [] : [input.expected]),
      ]);
    });

    const deleteRef = Effect.fn("Git.deleteRef")(function* (
      repo: string,
      ref: string,
      expected?: string,
    ) {
      yield* run(repo, [
        "update-ref",
        "-d",
        "--end-of-options",
        ref,
        ...(expected === undefined ? [] : [expected]),
      ]);
    });

    const localBranchTips = Effect.fn("Git.localBranchTips")(function* (
      repo: string,
    ) {
      const tips = splitLines(
        yield* run(repo, [
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/",
        ]),
      );
      return [...new Set(tips)].slice(0, LOCAL_TIPS_LIMIT);
    });

    const snapshotRemoteRefs = Effect.fn("Git.snapshotRemoteRefs")(function* (
      repo: string,
    ) {
      return yield* run(repo, [
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/remotes/",
      ]);
    });

    const refTips = Effect.fn("Git.refTips")(function* (repo: string) {
      const out = yield* run(repo, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(upstream)",
        "refs/heads/",
        "refs/remotes/",
        "refs/replace/",
      ]);
      return new Map(
        splitLines(out).map((line) => {
          const [ref = "", tip = "", upstream = ""] = line.split("\0");
          return [ref, { tip, upstream }] as const;
        }),
      );
    });

    const worktreeConfigOn = Effect.fn("Git.worktreeConfigOn")(function* (
      repo: string,
    ) {
      const out = yield* run(
        repo,
        ["config", "--type=bool", "--get", "extensions.worktreeConfig"],
        // Unset.
        { okExitCodes: [1] },
      );
      return out.trim() === "true";
    });

    return {
      verifyRev,
      refTip,
      readRef,
      treeOf,
      hasObject,
      hasCommit,
      isAncestor,
      resolveCommit,
      headAt,
      upstreamName,
      countCommits,
      ownCommitCounts,
      updateRef,
      deleteRef,
      localBranchTips,
      snapshotRemoteRefs,
      refTips,
      worktreeConfigOn,
    };
  });

export type RefsArea = Effect.Success<ReturnType<typeof makeRefs>>;
