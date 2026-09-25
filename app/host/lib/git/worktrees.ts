// The worktree reads the host makes. The rows and identities come from
// the CLI, which owns the data model (`sm worktrees list`, see
// host/ipc/cliDelegate.ts). What stays here is plain git the CLI has no
// verb for: the paged commit history, the upstream counts the
// auto-pull sweep decides on right before it pulls, and the prune
// after a data dir wipe.
import { createHash } from "node:crypto";
import { unknownWorktreeError } from "@shared/errors";
import {
  type CommitSummary,
  isCommitHash,
  type Worktree,
  type WorktreeIdentity,
} from "@shared/schemas";
import {
  describeWorktreeViaCli,
  listWorktreeIdentitiesViaCli,
  listWorktreesViaCli,
} from "@host/ipc/cliDelegate";
import { createLimiter } from "@shared/util/limit";
import { run } from "./core";

export type { WorktreeIdentity };

// The sidebar asks for every project's rows at once on a refresh, and
// each list runs up to six rows' probes at a time in the CLI (five git
// processes a row), so a couple of lists at a time keeps a refresh from
// forking hundreds of gits at once.
const rowLists = createLimiter(2);

// A project's rows, primary first.
export function listWorktrees(projectId: string): Promise<Worktree[]> {
  return rowLists(() => listWorktreesViaCli(projectId));
}

// One row, freshly probed.
export function describeWorktree(
  projectId: string,
  worktreeId: string,
): Promise<Worktree> {
  return describeWorktreeViaCli(projectId, worktreeId);
}

// A project's checkouts without git probes. `primaryRef` also resolves
// the project's primary ref onto each.
export function listWorktreeIdentities(
  projectId: string,
  opts: { primaryRef?: boolean } = {},
): Promise<WorktreeIdentity[]> {
  return listWorktreeIdentitiesViaCli({ projectId }, opts);
}

// The checkout `worktreeId` names, or the entity-gone error.
export async function findWorktreeIdentityOrThrow(
  projectId: string,
  worktreeId: string,
  opts: { primaryRef?: boolean } = {},
): Promise<WorktreeIdentity> {
  const [identity] = await listWorktreeIdentitiesViaCli(
    { projectId, worktreeId },
    opts,
  );
  if (!identity) throw unknownWorktreeError(worktreeId);
  return identity;
}

// The CLI's id rule (worktreeIDFromPath in cli/paths.go), for the few
// places that key something by a checkout path rather than by a listed
// identity (the mirror's scratch index dir). sha256 of the absolute
// path, 12 hex chars: the same path produces the same id anywhere.
// test/cli-reads.mjs pins it against the ids the CLI prints.
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
// contain tabs or newlines.
const LOG_SENTINEL = "\x01";
const LOG_FORMAT = `${LOG_SENTINEL}%h%x09%an%x09%aI%x09%s`;

function parseLog(stdout: string): CommitSummary[] {
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
    const [hash, author, date, ...subjectParts] = header.split("\t");
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
      subject: subjectParts.join("\t"),
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
  opts: { skip: number; count: number },
): Promise<CommitSummary[]> {
  try {
    const args = ["log", `--skip=${opts.skip}`, `-${opts.count}`];
    args.push(`--pretty=format:${LOG_FORMAT}`, "--shortstat");
    const stdout = await run(worktreePath, args);
    return parseLog(stdout);
  } catch {
    return [];
  }
}

// Drops admin entries under $GIT_DIR/worktrees whose checkout dir is
// gone. Used after the nuke-everything root wipe to keep `git worktree
// list` honest.
export async function pruneStaleWorktrees(projectPath: string): Promise<void> {
  await run(projectPath, ["worktree", "prune"]);
}
