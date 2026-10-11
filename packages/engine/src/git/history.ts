// Git's history: commits, logs and what a commit holds.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  LOG_FORMAT,
  parseLeftRight,
  parseLog,
  splitLines,
} from "../gitParse.ts";
import { FIRST_PARENT_LIMIT, UNPUSHED_LIMIT } from "./documents.ts";
import type { RunningArea } from "./running.ts";

export const makeHistory = ({ running }: { readonly running: RunningArea }) =>
  Effect.sync(() => {
    const { run, succeeds } = running;
    // --- history ---

    const aheadBehind = Effect.fn("Git.aheadBehind")(function* (
      worktree: string,
      ref: string,
    ) {
      if (ref === "") return Option.none();
      return yield* run(worktree, [
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${ref}`,
      ]).pipe(
        Effect.map((stdout) => Option.fromUndefinedOr(parseLeftRight(stdout))),
        Effect.orElseSucceed(() => Option.none()),
      );
    });

    const upstreamSync = Effect.fn("Git.upstreamSync")(function* (
      worktree: string,
    ) {
      const counts = yield* aheadBehind(worktree, "@{u}");
      if (Option.isNone(counts)) {
        return {
          ahead: 0,
          behind: 0,
          hasUpstream: false,
          divergedClean: false,
        };
      }
      const { ahead, behind } = counts.value;
      const divergedClean =
        ahead > 0 &&
        behind > 0 &&
        (yield* succeeds(worktree, [
          "merge-tree",
          "--write-tree",
          "HEAD",
          "@{u}",
        ]));
      return { ahead, behind, hasUpstream: true, divergedClean };
    });

    const unpushedCount = Effect.fn("Git.unpushedCount")(function* (
      worktree: string,
    ) {
      // Against every remote-tracking ref, so a commit pushed under
      // another name counts as shared. An unborn branch has nothing.
      return yield* run(worktree, [
        "rev-list",
        "--count",
        `--max-count=${UNPUSHED_LIMIT}`,
        "HEAD",
        "--not",
        "--remotes",
      ]).pipe(
        Effect.map((stdout) => Number.parseInt(stdout.trim(), 10) || 0),
        Effect.orElseSucceed(() => 0),
      );
    });

    const listCommits = Effect.fn("Git.listCommits")(function* (
      worktree: string,
      page: { readonly skip: number; readonly count: number },
    ) {
      return yield* run(worktree, [
        "log",
        `--skip=${page.skip}`,
        `-${page.count}`,
        `--pretty=format:${LOG_FORMAT}`,
        "--shortstat",
      ]).pipe(
        Effect.map(parseLog),
        Effect.orElseSucceed(() => []),
      );
    });

    const firstParentChain = Effect.fn("Git.firstParentChain")(function* (
      repo: string,
      ref: string,
    ) {
      if (ref === "") return Option.none();
      return yield* run(repo, [
        "rev-list",
        "--first-parent",
        `-n${FIRST_PARENT_LIMIT + 1}`,
        ref,
      ]).pipe(
        Effect.map(
          (stdout): Option.Option<ReadonlySet<string>> =>
            Option.some(new Set(splitLines(stdout))),
        ),
        Effect.orElseSucceed(() => Option.none()),
      );
    });

    // Whether the branch's work is in the primary. A branch behind the
    // primary and not ahead is in its history for one of two reasons:
    // its work was merged, or it never left (a worktree made and left
    // while the primary moved on). A merged branch hangs off the
    // primary's first-parent chain and an untouched one sits on it, which
    // keeps idle worktrees out of the merged list. A local fast-forward
    // or rebase merge reads as not landed: its history is identical.
    const primaryRelation = Effect.fn("Git.primaryRelation")(function* (input: {
      readonly worktree: string;
      readonly primaryRef: string;
      readonly chain: Effect.Effect<Option.Option<ReadonlySet<string>>>;
    }) {
      const counts = yield* aheadBehind(input.worktree, input.primaryRef);
      if (Option.isNone(counts))
        return { behindPrimary: 0, mergedIntoPrimary: false };
      const { ahead, behind } = counts.value;
      if (ahead > 0 || behind === 0 || behind > FIRST_PARENT_LIMIT) {
        return { behindPrimary: behind, mergedIntoPrimary: false };
      }
      const head = yield* run(input.worktree, ["rev-parse", "HEAD"]).pipe(
        Effect.map((stdout) => stdout.trim()),
        Effect.orElseSucceed(() => ""),
      );
      // An unread chain must read as "not landed": an empty one would put
      // every HEAD off it, i.e. merged.
      const chain = yield* input.chain;
      const merged =
        head !== "" && Option.isSome(chain) && !chain.value.has(head);
      return { behindPrimary: behind, mergedIntoPrimary: merged };
    });

    const readCommitMessage = Effect.fn("Git.readCommitMessage")(function* (
      worktree: string,
      hash: string,
    ) {
      // `%s` and `%b` are git's own split, and a NUL between them survives
      // any subject a person could type.
      const stdout = yield* run(worktree, [
        "show",
        "-s",
        "--format=%s%x00%b",
        "--end-of-options",
        hash,
        "--",
      ]);
      const cut = stdout.indexOf("\0");
      if (cut < 0) return { summary: stdout.trim(), description: "" };
      return {
        summary: stdout.slice(0, cut).trim(),
        description: stdout.slice(cut + 1).trim(),
      };
    });

    return {
      aheadBehind,
      upstreamSync,
      unpushedCount,
      listCommits,
      firstParentChain,
      primaryRelation,
      readCommitMessage,
    };
  });

export type HistoryArea = Effect.Success<ReturnType<typeof makeHistory>>;
