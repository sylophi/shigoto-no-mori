import { z } from "zod";
import { isRealBranch } from "./project";
import type { Worktree } from "./worktree";

// Extra facts the "tidy the forest" surface needs about one worktree.
// Deliberately narrow: everything already on `Worktree` (changedCount,
// ahead, hasUpstream, detached…) is reused rather than re-probed, so
// this call only pays for the questions nothing else asks.
//
// These are facts only. The judgement that decides what is safe to
// remove lives in `deriveHygieneVerdict` below, so the same rules run in
// the list, the summary and the confirm step. It is the same split
// `deriveRemoteSyncState` already uses for remote state.
export const WorktreeHygieneSchema = z.object({
  worktreeId: z.string(),
  // Epoch ms of the worktree's HEAD commit. Null for an empty repo or a
  // ref we couldn't read.
  lastCommitAt: z.number().int().nonnegative().nullable(),
  // The commit these facts were taken against, abbreviated the same way
  // `Worktree.recentCommits` abbreviates. The facts and the worktree
  // list are separate queries with separate lifetimes, and this is what
  // lets the verdict notice it is reading them from different moments.
  headHash: z.string().nullable(),
  // Commits on this worktree's HEAD that the primary ref doesn't have.
  // 0 means the branch is fully contained in primary, the classic
  // "already merged" case.
  //
  // Null when the count couldn't be taken at all: a prunable worktree
  // whose directory is gone, a corrupt repo, an unreadable ref. It has
  // to be distinguishable from 0, because 0 is the one value that gets
  // a row ticked for deletion on the user's behalf.
  uniqueCommits: z.number().int().nonnegative().nullable(),
  // True when merging this worktree into the primary ref would change
  // nothing, i.e. its content is already there. Catches the squash- and
  // rebase-merged branches that `uniqueCommits > 0` misses, since those
  // keep commits primary never took verbatim. False whenever the probe
  // failed or conflicted, so it fails safe.
  contentAlreadyInPrimary: z.boolean(),
  // The primary ref every comparison above was made against, e.g.
  // "main" or "origin/main". Null when it couldn't be resolved, which
  // downgrades the verdict to "unknown".
  primaryRef: z.string().nullable(),
  // True when this worktree has the project's own default branch
  // checked out. Removal deletes the local branch (see
  // deleteBranchOnRemove), and that branch is the one thing in the repo
  // nothing else can restore. Merged or not, it is never ticked.
  holdsPrimaryBranch: z.boolean(),
  // True when the worktree has untracked files that `changedCount`
  // didn't see. `git status` honours the user's
  // status.showUntrackedFiles setting, so under `-uno` a tree full of
  // uncommitted new files reports clean. This is checked separately for
  // exactly the rows that would otherwise be auto-ticked.
  untracked: z.boolean(),
});
export type WorktreeHygiene = z.infer<typeof WorktreeHygieneSchema>;

// Disk footprint of one worktree directory. Split from the facts above
// because measuring it walks the entire tree (node_modules included) and
// must never hold up the fast git-derived list.
export const WorktreeDiskUsageSchema = z.object({
  worktreeId: z.string(),
  // Bytes occupied on disk (block-based, matching `du`), not the sum of
  // apparent file sizes.
  bytes: z.number().int().nonnegative(),
  // Epoch ms of the newest file modification found while walking, with
  // dependency and build directories skipped so an install doesn't make
  // an abandoned worktree look freshly worked on. Null when the walk
  // found nothing datable.
  lastActivityAt: z.number().int().nonnegative().nullable(),
  // True when the walk hit unreadable entries, making the total a floor
  // rather than an exact figure. The UI prefixes these with "~".
  partial: z.boolean(),
});
export type WorktreeDiskUsage = z.infer<typeof WorktreeDiskUsageSchema>;

// How safe it is to remove a worktree. The tidy list preselects
// `merged` and `absorbed` only. Everything else takes a deliberate
// click plus an explicit acknowledgement.
export type HygieneVerdictKind =
  | "primary" // the project's own checkout, never removable
  | "defaultBranch" // holds the project's default branch: removal would delete it
  | "merged" // no unique commits: fully contained in primary
  | "absorbed" // squash/rebase merged: content already in primary
  | "dirty" // uncommitted changes would be destroyed
  | "unpushed" // commits that exist nowhere else
  | "active" // real unmerged work
  | "unknown"; // can't compare, so we don't guess

export interface HygieneVerdict {
  kind: HygieneVerdictKind;
  // True only for verdicts we are willing to tick on the user's behalf.
  safe: boolean;
  // True when `git worktree remove` will refuse without --force. Lives
  // on the verdict because the reason it refuses is the same evidence
  // the verdict is reporting, and one of those reasons (untracked files
  // under `-uno`) is invisible to changedCount.
  needsForce: boolean;
  // One short sentence naming the evidence. Shown on the row and
  // repeated in the confirm step, so the consequence is never implicit.
  reason: string;
}

// The `Worktree` fields the verdict reads. Spelled out as a Pick so a
// caller can't accidentally pass a half-built row.
export type HygieneWorktreeFacts = Pick<
  Worktree,
  | "changedCount"
  | "isPrimary"
  | "branch"
  | "detached"
  | "ahead"
  | "hasUpstream"
  | "recentCommits"
>;

export function deriveHygieneVerdict(
  worktree: HygieneWorktreeFacts,
  hygiene: WorktreeHygiene | undefined,
): HygieneVerdict {
  if (worktree.isPrimary) {
    return {
      kind: "primary",
      safe: false,
      needsForce: false,
      reason: "The project's primary checkout.",
    };
  }
  // Dirty beats everything. Uncommitted work is the one thing removal
  // can destroy with no copy anywhere, so it is reported first even when
  // the branch is also merged.
  if (worktree.changedCount > 0) {
    return {
      kind: "dirty",
      safe: false,
      needsForce: true,
      reason: `${worktree.changedCount} uncommitted ${
        worktree.changedCount === 1 ? "change" : "changes"
      } would be lost.`,
    };
  }
  // Untracked files the status scan didn't count. Same consequence as
  // dirty -- files that exist nowhere else -- so it is reported the same
  // way, just after it, since the count above is the more precise one
  // whenever it was taken.
  if (hygiene?.untracked) {
    return {
      kind: "dirty",
      safe: false,
      needsForce: true,
      reason: "Untracked files here would be lost.",
    };
  }
  if (worktree.detached || !isRealBranch(worktree.branch)) {
    return {
      kind: "unknown",
      safe: false,
      needsForce: false,
      reason: "Detached HEAD, so there is nothing to compare against.",
    };
  }
  // Merged or not, removing this deletes the local branch the whole
  // project is built on. Never ticked, and never presented as tidy-able.
  if (hygiene?.holdsPrimaryBranch) {
    return {
      kind: "defaultBranch",
      safe: false,
      needsForce: false,
      reason: `Removing this deletes ${worktree.branch}, the project's default branch.`,
    };
  }
  // Facts still loading, or the primary ref wouldn't resolve. Either way
  // we can't judge, so we don't.
  if (!hygiene || !hygiene.primaryRef) {
    return {
      kind: "unknown",
      safe: false,
      needsForce: false,
      reason: hygiene
        ? "Couldn't resolve a primary branch to compare against."
        : "Still checking…",
    };
  }
  // The facts and the worktree list are separate queries. If HEAD has
  // moved since these were taken, they describe a commit that is no
  // longer checked out, and "every commit is already in main" is exactly
  // the wrong thing to say about work committed since. Reported as not
  // knowing, which resolves itself on the next fetch.
  if (hygiene.headHash !== (worktree.recentCommits[0]?.hash ?? null)) {
    return {
      kind: "unknown",
      safe: false,
      needsForce: false,
      reason: "This worktree has moved on since it was last checked.",
    };
  }
  // A probe that couldn't run at all reports null, not 0. Treating the
  // two alike is how a worktree whose directory has gone missing would
  // read as "every commit is already in main" and get ticked.
  if (hygiene.uniqueCommits === null) {
    return {
      kind: "unknown",
      safe: false,
      needsForce: false,
      reason: `Couldn't compare this worktree against ${hygiene.primaryRef}.`,
    };
  }
  if (hygiene.uniqueCommits === 0) {
    return {
      kind: "merged",
      safe: true,
      needsForce: false,
      reason: `Every commit is already in ${hygiene.primaryRef}.`,
    };
  }
  if (hygiene.contentAlreadyInPrimary) {
    return {
      kind: "absorbed",
      safe: true,
      needsForce: false,
      reason: `Squash- or rebase-merged: these changes are already in ${hygiene.primaryRef}.`,
    };
  }
  // Commits that exist only here: either never pushed, or pushed to an
  // upstream that is itself behind. Called out separately because
  // removal is the one case that loses history outright.
  const unpushed = worktree.hasUpstream ? worktree.ahead > 0 : true;
  const commitCount = `${hygiene.uniqueCommits} ${
    hygiene.uniqueCommits === 1 ? "commit" : "commits"
  }`;
  if (unpushed) {
    return {
      kind: "unpushed",
      safe: false,
      needsForce: false,
      reason: `${commitCount} not in ${hygiene.primaryRef}, and not pushed anywhere.`,
    };
  }
  return {
    kind: "active",
    safe: false,
    needsForce: false,
    reason: `${commitCount} not in ${hygiene.primaryRef}.`,
  };
}

// Short label for the verdict badge, kept beside the verdict so the
// wording can't drift between the list, the summary and the confirm.
export const HYGIENE_VERDICT_LABEL: Record<HygieneVerdictKind, string> = {
  primary: "Primary",
  defaultBranch: "Default branch",
  merged: "Merged",
  absorbed: "Already in primary",
  dirty: "Uncommitted work",
  unpushed: "Unpushed commits",
  active: "Active work",
  unknown: "Can't tell",
};
