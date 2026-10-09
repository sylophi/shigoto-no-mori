// The worktree reads the host makes. The rows and identities come from
// the engine, which owns the data model (Worktrees.list, see
// host/lib/engineCalls.ts). What stays here is plain git the engine
// has no service for: the paged commit history, the upstream counts the
// auto-pull sweep decides on right before it pulls, and the prune
// after a data dir wipe.
import { createHash } from "node:crypto";
import { UnknownWorktreeError } from "@shigomori/contracts/errors";
import {
  type BranchHistory,
  type CommitSummary,
  isCommitHash,
  type Worktree,
  type WorktreeIdentity,
} from "@shigomori/contracts/schemas";
import * as EngineCalls from "@host/lib/engineCalls";
import { createLimiter } from "@shared/util/limit";
import { run, runLenient } from "./core";
import { upstreamName } from "./refs";

export type { WorktreeIdentity };

// The sidebar asks for every project's rows at once on a refresh, and
// each list runs up to six rows' probes at a time in the CLI (five git
// processes a row), so a couple of lists at a time keeps a refresh from
// forking hundreds of gits at once.
const rowLists = createLimiter(2);

// A project's rows, primary first.
export function listWorktrees(projectId: string): Promise<readonly Worktree[]> {
  return rowLists(() => EngineCalls.listWorktrees(projectId));
}

// One row, freshly probed.
export function describeWorktree(
  projectId: string,
  worktreeId: string,
): Promise<Worktree> {
  return EngineCalls.describeWorktree(projectId, worktreeId);
}

// A project's checkouts without git probes. `primaryRef` also resolves
// the project's primary ref onto each.
export function listWorktreeIdentities(
  projectId: string,
  opts: { primaryRef?: boolean } = {},
): Promise<readonly WorktreeIdentity[]> {
  return EngineCalls.listWorktreeIdentities({ projectId }, opts);
}

// The checkout `worktreeId` names, or the entity-gone error.
export async function findWorktreeIdentityOrThrow(
  projectId: string,
  worktreeId: string,
  opts: { primaryRef?: boolean } = {},
): Promise<WorktreeIdentity> {
  const [identity] = await EngineCalls.listWorktreeIdentities(
    { projectId, worktreeId },
    opts,
  );
  if (!identity) throw new UnknownWorktreeError({ worktreeId });
  return identity;
}

// The engine's id rule (worktreeIdFromPath in worktreeLayout.ts), for the few
// places that key something by a checkout path rather than by a listed
// identity (the mirror's scratch index dir). sha256 of the absolute
// path, 12 hex chars: the same path produces the same id anywhere.
export function worktreeIdFromPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

// Commits HEAD has that the upstream lacks, and vice versa. Null when
// there is no upstream to measure against: the branch was never
// pushed, its remote branch is gone, or HEAD is detached. The auto-pull
// sweep asks right before it pulls, never trusting a row that can be a
// focus old.
export async function getUpstreamCounts(
  worktreePath: string,
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const stdout = await run(worktreePath, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    const [a, b] = stdout.trim().split(/\s+/);
    return { ahead: Number(a) || 0, behind: Number(b) || 0 };
  } catch {
    return null;
  }
}

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
export async function listCommits(
  worktreePath: string,
  opts: { skip: number; count: number; query?: string; from?: string },
): Promise<CommitSummary[]> {
  try {
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
    const stdout = await run(worktreePath, args);
    return parseLog(stdout);
  } catch {
    return [];
  }
}

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
export async function readBranchHistory(
  worktreePath: string,
  opts: { base: string | undefined; count: number },
): Promise<BranchHistory> {
  const short = async (rev: string) =>
    (
      await runLenient(worktreePath, [
        "log",
        "-1",
        "--format=%h",
        "--end-of-options",
        rev,
        "--",
      ])
    ).trim();
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
    await Promise.all([
      upstreamName(worktreePath),
      opts.base
        ? runLenient(worktreePath, ["merge-base", "HEAD", opts.base])
        : Promise.resolve(""),
      runLenient(worktreePath, [
        "log",
        "--format=%h",
        "--max-count=1000",
        "--end-of-options",
        "@{u}..HEAD",
        "--",
      ]),
      log("HEAD..@{u}").then(parseLog),
      runLenient(worktreePath, ["merge-base", "HEAD", "@{u}"]),
    ]);
  const baseHash = mergeBase.trim();
  const forkHash = forkOut.trim();
  const range = baseHash ? `${baseHash}..HEAD` : "HEAD";
  const [base, own, merges, upstreamFork] = await Promise.all([
    opts.base && baseHash
      ? short(baseHash).then((hash) => ({ ref: opts.base ?? "", hash }))
      : Promise.resolve(null),
    log(range).then(parseLog),
    runLenient(worktreePath, [
      "log",
      "--merges",
      "--format=%h %p",
      `-${opts.count}`,
      "--end-of-options",
      range,
      "--",
    ]),
    forkHash ? short(forkHash) : Promise.resolve(""),
  ]);
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
  };
}

// Drops admin entries under $GIT_DIR/worktrees whose checkout dir is
// gone. Used after the nuke-everything root wipe to keep `git worktree
// list` honest.
export async function pruneStaleWorktrees(projectPath: string): Promise<void> {
  await run(projectPath, ["worktree", "prune"]);
}
