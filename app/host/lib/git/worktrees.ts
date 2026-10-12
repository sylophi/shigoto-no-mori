// A worktree's history as its page reads it: the paged log, and the
// branch's own commits against its upstream and its base. The engine's
// Git takes these with the rest of the history (V3.md, item 15).
import {
  type BranchHistory,
  type CommitSummary,
  isCommitHash,
} from "@shigomori/contracts/schemas";
import * as Git from "@shigomori/engine/Git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { run, runLenient } from "./core";

// `--shortstat` appends " N files changed, X insertions(+), Y deletions(-)"
// on its own line after each commit's formatted output. A SOH (\x01)
// sentinel between records keeps parsing robust against subjects that
// contain tabs or newlines, and NUL between fields against an author
// name with a tab (git keeps those). The engine reads its own `git log` the
// same way (gitParse.ts), and both are held to
// shared/fixtures/git-log.json.
const LOG_SENTINEL = "\x01";
export const LOG_FORMAT = `${LOG_SENTINEL}%h%x00%an%x00%aI%x00%s`;

export function parseLog(stdout: string): CommitSummary[] {
  // A record only opens at a sentinel that starts a line. Git emits a raw
  // SOH from `%s`, but it folds a subject's newlines into spaces, so a
  // subject carrying one stays inside its own header line rather than
  // opening a record of its own. Anything else on a line belongs to the
  // open record's `--shortstat` tail.
  const records: { header: string; stats: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(LOG_SENTINEL)) {
      records.push({ header: line.slice(LOG_SENTINEL.length), stats: "" });
      continue;
    }
    const open = records.at(-1);
    if (open) open.stats += line;
  }
  const commits: CommitSummary[] = [];
  for (const { header, stats } of records) {
    const [hash, author, date, ...subjectParts] = header.split("\0");
    // Belt and braces on top of the line-anchored split: a record whose
    // first field isn't an abbreviated sha isn't a commit, so drop it
    // instead of letting it reach the renderer (and, from there, git
    // argv) as an attacker-chosen string.
    if (!hash || !isCommitHash(hash)) continue;
    const insMatch = /(\d+) insertions?\(\+\)/.exec(stats);
    const delMatch = /(\d+) deletions?\(-\)/.exec(stats);
    commits.push({
      hash,
      author: author ?? "",
      date: date ?? "",
      subject: subjectParts.join("\0"),
      additions: insMatch ? Number(insMatch[1]) : 0,
      deletions: delMatch ? Number(delMatch[1]) : 0,
    });
  }
  return commits;
}

// Paginated branch history. `skip` walks back through `git log HEAD` so
// the renderer's infinite-scroll drawer can page in chunks; the teaser
// in the detail page passes skip=0 with a small count. Returns [] on
// any git failure (empty repo, detached state mid-rebase) so callers
// don't have to fork on error.
export const listCommits = (
  worktreePath: string,
  opts: { skip: number; count: number; query?: string; from?: string },
) => {
  const args = ["log", `--skip=${opts.skip}`, `-${opts.count}`];
  // A search of the messages, literal and case blind.
  if (opts.query) {
    args.push(
      "--fixed-strings",
      "--regexp-ignore-case",
      `--grep=${opts.query}`,
    );
  }
  args.push(
    `--pretty=format:${LOG_FORMAT}`,
    "--shortstat",
    "--diff-merges=first-parent",
  );
  // History from a commit other than HEAD: where a branch left its base,
  // for the history before the branch's own commits.
  if (opts.from) args.push("--end-of-options", opts.from, "--");
  return run(worktreePath, args).pipe(
    Effect.map(parseLog),
    Effect.orElseSucceed((): CommitSummary[] => []),
  );
};

// What the Git page's History tab draws: the branch's own commits,
// newest first (children before parents, so a merge never lists its
// side above what it was merged into), back to where it left `base`
// (the project's primary ref), and which commit that is. Without a base
// (the primary checkout, a branch that is the primary branch, a
// detached HEAD) it is the newest commits of HEAD. `more` says the list
// was cut at `count`.
//
// Against the upstream: which of HEAD's commits it lacks (`unpushed`,
// by the same short hash the list uses), which of its own HEAD lacks
// (`incoming`, cut at `count` too), and where the two last agreed
// (`upstreamFork`). Both sides holding commits of their own is a split
// the tab shows a side of at a time. Without an upstream all are empty.
// `merges` are the listed commits with more than one parent, with the
// first: the commit menu won't rewrite across one, and a merge on top
// is undone back to its first parent. Every commit's counts are against its
// first parent, so a merge's are what it brought in.
export const readBranchHistory = Effect.fnUntraced(function* (
  worktreePath: string,
  opts: { base: string | undefined; count: number },
) {
  const short = (rev: string) =>
    Effect.map(
      runLenient(worktreePath, [
        "log",
        "-1",
        "--format=%h",
        "--end-of-options",
        rev,
        "--",
      ]),
      (out) => out.trim(),
    );
  const log = (range: string) =>
    runLenient(worktreePath, [
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
  // what reads past where the branch left its base. Without an upstream
  // the reads against it fail and come back empty.
  const [upstream, mergeBase, unpushedOut, incoming, forkOut] =
    yield* Effect.all(
      [
        Effect.flatMap(Git.Git, (git) => git.upstreamName(worktreePath)).pipe(
          Effect.map(Option.getOrNull),
        ),
        opts.base
          ? runLenient(worktreePath, ["merge-base", "HEAD", opts.base])
          : Effect.succeed(""),
        runLenient(worktreePath, [
          "log",
          "--format=%h",
          "--max-count=1000",
          "--end-of-options",
          "@{u}..HEAD",
          "--",
        ]),
        Effect.map(log("HEAD..@{u}"), parseLog),
        runLenient(worktreePath, ["merge-base", "HEAD", "@{u}"]),
      ],
      { concurrency: "unbounded" },
    );
  const baseHash = mergeBase.trim();
  const forkHash = forkOut.trim();
  const range = baseHash ? `${baseHash}..HEAD` : "HEAD";
  const [base, own, merges, upstreamFork] = yield* Effect.all(
    [
      opts.base && baseHash
        ? Effect.map(short(baseHash), (hash) => ({
            ref: opts.base ?? "",
            hash,
          }))
        : Effect.succeed(null),
      Effect.map(log(range), parseLog),
      runLenient(worktreePath, [
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
