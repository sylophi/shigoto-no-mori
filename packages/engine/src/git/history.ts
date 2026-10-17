// Git's history: commits, logs and what a commit holds.
import { type BranchHistory, isCommitHash } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  LOG_FORMAT,
  parseLeftRight,
  parseLog,
  splitLines,
} from "../gitParse.ts";
import { FIRST_PARENT_LIMIT, UNPUSHED_LIMIT } from "./documents.ts";
import type { RefsArea } from "./refs.ts";
import type { RunningArea } from "./running.ts";

export const makeHistory = ({
  running,
  refs,
}: {
  readonly running: RunningArea;
  readonly refs: RefsArea;
}) =>
  Effect.sync(() => {
    const { run, runLenient, succeeds } = running;
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
      page: {
        readonly skip: number;
        readonly count: number;
        readonly query?: string | undefined;
        readonly from?: string | undefined;
      },
    ) {
      return yield* run(worktree, [
        "log",
        `--skip=${page.skip}`,
        `-${page.count}`,
        // A search of the messages, literal and case blind.
        ...(page.query
          ? ["--fixed-strings", "--regexp-ignore-case", `--grep=${page.query}`]
          : []),
        `--pretty=format:${LOG_FORMAT}`,
        "--shortstat",
        // A merge's counts are what it brought in.
        "--diff-merges=first-parent",
        // History from a commit other than HEAD.
        ...(page.from ? ["--end-of-options", page.from, "--"] : []),
      ]).pipe(
        Effect.map(parseLog),
        Effect.orElseSucceed(() => []),
      );
    });

    // What the Git page's History tab draws: the branch's own commits,
    // newest first (children before parents, so a merge never lists its
    // side above what it was merged into), back to where it left `base`
    // (the project's primary ref), and which commit that is. Without a
    // base (the primary checkout, a branch that is the primary branch, a
    // detached HEAD) it is the newest commits of HEAD. `more` says the
    // list was cut at `count`.
    //
    // Against the upstream: which of HEAD's commits it lacks
    // (`unpushed`, by the same short hash the list uses), which of its
    // own HEAD lacks (`incoming`, cut at `count` too), and where the two
    // last agreed (`upstreamFork`). Without an upstream all are empty.
    // `merges` are the listed commits with more than one parent, with
    // the first: the commit menu won't rewrite across one, and a merge
    // on top is undone back to its first parent. Every commit's counts
    // are against its first parent, so a merge's are what it brought in.
    const readBranchHistory = Effect.fn("Git.readBranchHistory")(function* (
      worktree: string,
      opts: { readonly base: string | undefined; readonly count: number },
    ) {
      const short = (rev: string) =>
        runLenient(worktree, [
          "log",
          "-1",
          "--format=%h",
          "--end-of-options",
          rev,
          "--",
        ]).pipe(Effect.map((out) => out.trim()));
      const log = (range: string) =>
        runLenient(worktree, [
          "log",
          `-${opts.count + 1}`,
          "--topo-order",
          `--pretty=format:${LOG_FORMAT}`,
          "--shortstat",
          "--diff-merges=first-parent",
          "--end-of-options",
          range,
          "--",
        ]);
      // Two rounds: everything that needs no answer from another, then
      // what reads past where the branch left its base. Without an
      // upstream the reads against it fail and come back empty.
      const [upstream, mergeBase, unpushedOut, incoming, forkOut] =
        yield* Effect.all(
          [
            refs.upstreamName(worktree).pipe(Effect.map(Option.getOrNull)),
            opts.base
              ? runLenient(worktree, ["merge-base", "HEAD", opts.base])
              : Effect.succeed(""),
            runLenient(worktree, [
              "log",
              "--format=%h",
              "--max-count=1000",
              "--end-of-options",
              "@{u}..HEAD",
              "--",
            ]),
            log("HEAD..@{u}").pipe(Effect.map(parseLog)),
            runLenient(worktree, ["merge-base", "HEAD", "@{u}"]),
          ],
          { concurrency: "unbounded" },
        );
      const baseHash = mergeBase.trim();
      const forkHash = forkOut.trim();
      const range = baseHash ? `${baseHash}..HEAD` : "HEAD";
      const [base, own, merges, upstreamFork] = yield* Effect.all(
        [
          opts.base && baseHash
            ? short(baseHash).pipe(
                Effect.map((hash) => ({ ref: opts.base ?? "", hash })),
              )
            : Effect.succeed(null),
          log(range).pipe(Effect.map(parseLog)),
          runLenient(worktree, [
            "log",
            "--merges",
            "--format=%h %p",
            `-${opts.count}`,
            "--end-of-options",
            range,
            "--",
          ]),
          forkHash ? short(forkHash) : Effect.succeed(""),
        ],
        { concurrency: "unbounded" },
      );
      return {
        commits: own.slice(0, opts.count),
        more: own.length > opts.count,
        base,
        upstream,
        unpushed: unpushedOut.split("\n").filter(isCommitHash),
        incoming: incoming.slice(0, opts.count),
        incomingMore: incoming.length > opts.count,
        upstreamFork: upstreamFork || null,
        merges: merges.split("\n").flatMap((line) => {
          const [hash = "", firstParent = ""] = line.split(" ");
          return isCommitHash(hash) && isCommitHash(firstParent)
            ? [{ hash, firstParent }]
            : [];
        }),
      } satisfies BranchHistory;
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
      readBranchHistory,
      firstParentChain,
      primaryRelation,
      readCommitMessage,
    };
  });
