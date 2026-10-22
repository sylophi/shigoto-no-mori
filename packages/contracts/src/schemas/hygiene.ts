import { pluralize } from "../words.ts";
import * as Schema from "effect/Schema";
import { isRealBranch } from "./project.ts";
import type { Worktree } from "./worktree.ts";

// Only what `Worktree` doesn't already carry. Facts only: the judgement
// is deriveHygieneVerdict's.
export const WorktreeHygieneSchema = Schema.Struct({
  worktreeId: Schema.String,
  lastCommitAt: Schema.NullOr(Schema.Natural),
  // Abbreviated as `recentCommits` is, so the verdict can tell when the
  // facts and the worktree list are from different moments.
  headHash: Schema.NullOr(Schema.String),
  // Null when it couldn't be taken, which must stay distinct from 0: 0
  // gets a row ticked for deletion on the user's behalf.
  uniqueCommits: Schema.NullOr(Schema.Natural),
  // Catches squash- and rebase-merged branches. False whenever the probe
  // failed or conflicted, so it fails safe.
  contentAlreadyInPrimary: Schema.Boolean,
  primaryRef: Schema.NullOr(Schema.String),
  // Removal would delete the local default branch, which nothing else
  // can restore.
  holdsPrimaryBranch: Schema.Boolean,
  // Untracked files, by a check of its own that reads true when it
  // can't tell.
  untracked: Schema.Boolean,
});
export type WorktreeHygiene = typeof WorktreeHygieneSchema.Type;

// Split from the facts: the walk is slow and must never hold up the list.
export const WorktreeDiskUsageSchema = Schema.Struct({
  worktreeId: Schema.String,
  // Block-based, as `du` counts.
  bytes: Schema.Natural,
  // Less what it shares with clones and hard links elsewhere. Blocks two
  // worktrees share only with each other count in neither, so removing
  // both can free more than the sum.
  reclaimableBytes: Schema.Natural,
  // Dependency and build directories skipped, so an install doesn't make
  // an abandoned worktree look fresh.
  lastActivityAt: Schema.NullOr(Schema.Natural),
  // Unreadable entries: the total is a floor.
  partial: Schema.Boolean,
});
export type WorktreeDiskUsage = typeof WorktreeDiskUsageSchema.Type;

export type HygieneVerdictKind =
  | "defaultBranch" // holds the project's default branch: removal would delete it
  | "merged" // no unique commits: fully contained in primary
  | "absorbed" // squash/rebase merged: content already in primary
  | "dirty" // uncommitted changes would be destroyed
  | "unpushed" // commits that exist nowhere else
  | "active" // real unmerged work
  | "unknown"; // can't compare, so we don't guess

export interface HygieneVerdict {
  kind: HygieneVerdictKind;
  safe: boolean;
  needsForce: boolean;
  reason: string;
}

export type HygieneWorktreeFacts = Pick<
  Worktree,
  | "changedCount"
  | "branch"
  | "detached"
  | "ahead"
  | "hasUpstream"
  | "recentCommits"
>;

function verdict(kind: HygieneVerdictKind, reason: string): HygieneVerdict {
  return {
    kind,
    safe: kind === "merged" || kind === "absorbed",
    needsForce: kind === "dirty",
    reason,
  };
}

export function deriveHygieneVerdict(
  worktree: HygieneWorktreeFacts,
  hygiene: WorktreeHygiene | undefined,
): HygieneVerdict {
  // Uncommitted work has no copy anywhere, so it beats everything.
  if (worktree.changedCount > 0) {
    return verdict(
      "dirty",
      `${pluralize(worktree.changedCount, "uncommitted change")} would be lost.`,
    );
  }
  if (hygiene?.untracked) {
    return verdict("dirty", "Untracked files here would be lost.");
  }
  if (worktree.detached || !isRealBranch(worktree.branch)) {
    return verdict(
      "unknown",
      "Detached HEAD, so there is nothing to compare against.",
    );
  }
  if (hygiene?.holdsPrimaryBranch) {
    return verdict(
      "defaultBranch",
      `Removing this deletes ${worktree.branch}, the project's default branch.`,
    );
  }
  if (!hygiene || !hygiene.primaryRef) {
    return verdict(
      "unknown",
      hygiene
        ? "Couldn't resolve a primary branch to compare against."
        : "Still checking…",
    );
  }
  // Facts about a commit no longer checked out would call work committed
  // since "already in main".
  if (hygiene.headHash !== (worktree.recentCommits[0]?.hash ?? null)) {
    return verdict(
      "unknown",
      "This worktree has moved on since it was last checked.",
    );
  }
  if (hygiene.uniqueCommits === null) {
    return verdict(
      "unknown",
      `Couldn't compare this worktree against ${hygiene.primaryRef}.`,
    );
  }
  if (hygiene.uniqueCommits === 0) {
    return verdict(
      "merged",
      `Every commit is already in ${hygiene.primaryRef}.`,
    );
  }
  if (hygiene.contentAlreadyInPrimary) {
    return verdict(
      "absorbed",
      `Squash- or rebase-merged: these changes are already in ${hygiene.primaryRef}.`,
    );
  }
  const unpushed = worktree.hasUpstream ? worktree.ahead > 0 : true;
  const commitCount = pluralize(hygiene.uniqueCommits, "commit");
  if (unpushed) {
    return verdict(
      "unpushed",
      `${commitCount} not in ${hygiene.primaryRef}, and not pushed anywhere.`,
    );
  }
  return verdict("active", `${commitCount} not in ${hygiene.primaryRef}.`);
}

export const HYGIENE_VERDICT_LABEL: Record<HygieneVerdictKind, string> = {
  defaultBranch: "Default branch",
  merged: "Merged",
  absorbed: "Already in primary",
  dirty: "Uncommitted work",
  unpushed: "Unpushed commits",
  active: "Active work",
  unknown: "Can't tell",
};
