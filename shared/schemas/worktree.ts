import { z } from "zod";
import { isRealBranch } from "./project";

export const CommitSummarySchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
  // Net additions/deletions across all files in this commit, parsed
  // from `git log --shortstat`. Zero for empty/merge commits.
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type CommitSummary = z.infer<typeof CommitSummarySchema>;

export const WorktreeSchema = z.object({
  id: z.string(),
  projectId: z.string().min(1),
  // The worktree's identity — directory basename. Stable across branch
  // checkouts/renames; for shigomori-created worktrees it's a randomly
  // picked animal name.
  name: z.string(),
  // The currently checked-out branch. A *property* of the worktree, not
  // its identity. May change via `git checkout` / `git branch -m`.
  branch: z.string(),
  path: z.string(),
  // Commits this worktree has that its upstream doesn't, and vice versa.
  // Both 0 when synced, when there's no upstream, or when HEAD is
  // detached -- consumers should check `hasUpstream` to disambiguate.
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  // True when the branch has an upstream configured AND that upstream
  // still resolves (i.e. `@{u}` works). False for detached HEAD, brand-
  // new local branches, or branches whose tracked remote was deleted.
  hasUpstream: z.boolean(),
  // True when the project has at least one git remote configured. Drives
  // whether "Publish" is offered as an action versus only as a hint.
  hasRemote: z.boolean(),
  // Only meaningful when ahead > 0 && behind > 0. True when a merge
  // probe (`git merge-tree --write-tree`) reports no conflicts. The
  // Pull-and-push action tries `git rebase @{u}` first (linear history)
  // and falls back to `git merge @{u}` if a per-commit replay would
  // conflict -- the probe guarantees the merge will land.
  divergedClean: z.boolean(),
  // Commits the project's primary branch (resolved via the same logic
  // as the "default branch" picker) has that this worktree's HEAD does
  // not. 0 for the primary worktree, detached HEAD, or when the primary
  // ref can't be resolved -- the UI uses > 0 as the gate for offering
  // the "Sync from primary" action.
  behindPrimary: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  // Most-recent first. Empty when the worktree has no commits yet.
  // Bounded by the backend (currently 4) so the IPC payload stays
  // small: 3 for the teaser plus 1 extra to signal "more available".
  recentCommits: z.array(CommitSummarySchema),
  port: z.number().int().positive().optional(),
  // The repo's primary checkout. Shown in the UI for context but never
  // removable — deleting it would mean detaching the project itself.
  isPrimary: z.boolean(),
  // True when the worktree lives outside shigomori's managed worktrees dir
  // (i.e. created manually or by another tool). Primary checkouts are also
  // technically external; the UI tags only non-primary externals.
  isExternal: z.boolean(),
  // True when HEAD points at a commit rather than a branch. In this case
  // `branch` holds the short commit hash, not a real branch name — so
  // rename is impossible and the UI styles it as a hash, not a branch.
  detached: z.boolean(),
  // User-driven "out of focus" flag. Filtered out of the sidebar's main
  // list by default but recoverable via the per-project "Show shelved"
  // toggle. The worktree itself is untouched on disk.
  shelved: z.boolean(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

// A worktree's relationship to its upstream, derived from the raw counts
// on Worktree. The renderer switches on `kind` to pick the right pill;
// the backend just reports facts so it stays dumb. "publish" covers
// both "no upstream / remote exists" and "no upstream / no remote",
// distinguished by `canPublish` so the UI can disable the button.
export type RemoteSyncState =
  | { kind: "detached" }
  | { kind: "synced" }
  | { kind: "publish"; canPublish: boolean }
  | { kind: "ahead"; ahead: number }
  | { kind: "behind"; behind: number }
  | { kind: "pullAndPush"; ahead: number; behind: number }
  | { kind: "diverged"; ahead: number; behind: number };

export function deriveRemoteSyncState(
  worktree: Pick<
    Worktree,
    | "ahead"
    | "behind"
    | "hasUpstream"
    | "hasRemote"
    | "divergedClean"
    | "detached"
    | "branch"
  >,
): RemoteSyncState {
  if (worktree.detached || !isRealBranch(worktree.branch)) {
    return { kind: "detached" };
  }
  if (!worktree.hasUpstream) {
    return { kind: "publish", canPublish: worktree.hasRemote };
  }
  if (worktree.ahead === 0 && worktree.behind === 0) return { kind: "synced" };
  if (worktree.behind === 0) return { kind: "ahead", ahead: worktree.ahead };
  if (worktree.ahead === 0) return { kind: "behind", behind: worktree.behind };
  if (worktree.divergedClean) {
    return {
      kind: "pullAndPush",
      ahead: worktree.ahead,
      behind: worktree.behind,
    };
  }
  return { kind: "diverged", ahead: worktree.ahead, behind: worktree.behind };
}

export const ListWorktreesPayloadSchema = z.object({
  projectId: z.string().min(1),
});

export const CreateWorktreePayloadSchema = z.object({
  projectId: z.string().min(1),
  // Optional: caller-picked animal dirname. Falls back to the backend's
  // own pick when omitted or when the requested name is already in use.
  worktreeName: z.string().min(1).optional(),
  // Optional: when omitted, the worktree's auto-picked animal name is
  // used as the branch name too (the quick-create shortcut).
  branchName: z.string().min(1).optional(),
  base: z.string().optional(),
  // When true: check out `base` as the worktree's branch (no -b, no new
  // branch). Requires `base` to be set and not already checked out
  // elsewhere. Ignores `branchName`.
  checkout: z.boolean().optional(),
});

export const CarryOverFailureSchema = z.object({
  path: z.string(),
  reason: z.string(),
});
export type CarryOverFailure = z.infer<typeof CarryOverFailureSchema>;

export const CarryOverReportSchema = z.object({
  applied: z.number().int().nonnegative(),
  failures: z.array(CarryOverFailureSchema),
});
export type CarryOverReport = z.infer<typeof CarryOverReportSchema>;

export const CreateWorktreeResultSchema = z.object({
  worktree: WorktreeSchema,
});
export type CreateWorktreeResult = z.infer<typeof CreateWorktreeResultSchema>;

// Phases the create lifecycle steps through, in order. Skipped if the
// phase has no work (no carry-over entries, no setup script, port-pool
// disabled). "idle" is the terminal sentinel emitted from `finally`.
export const CreatePhaseSchema = z.enum([
  "carryOver",
  "setup",
  "portPoolProvision",
]);
export type CreatePhase = z.infer<typeof CreatePhaseSchema>;

export const WorktreeLifecyclePhaseSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  phase: z.union([CreatePhaseSchema, z.literal("idle")]),
});
export type WorktreeLifecyclePhase = z.infer<
  typeof WorktreeLifecyclePhaseSchema
>;

export const WorktreeCarryOverCompleteSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  report: CarryOverReportSchema,
});
export type WorktreeCarryOverComplete = z.infer<
  typeof WorktreeCarryOverCompleteSchema
>;

export const ConvertExternalWorktreePayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
});

export const RelocateWorktreePayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  // Absolute target directory for the moved worktree (parent is
  // created if it doesn't exist).
  destinationPath: z.string().min(1),
});

export const DeleteWorktreePayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  force: z.boolean().optional(),
  skipCleanup: z.boolean().optional(),
});

export const RenameBranchPayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  newBranch: z.string().min(1),
});

export const SetShelvedPayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  shelved: z.boolean(),
});

export const CheckoutBranchPayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  branch: z.string().min(1),
});

// Every remote-sync mutation operates on a single worktree, so payload
// and result are shared across push/pull/force-push/overwrite/publish
// /pull-and-push. The result is the refreshed Worktree so the renderer
// can update its UI without an extra round trip.
export const SyncWorktreePayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
});

export const WorktreeDiffPayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
});

export const CommitDiffPayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  hash: z.string().min(1),
});

export const ListCommitsPayloadSchema = z.object({
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  // `git log --skip=N -n COUNT`; the renderer pages through with skip
  // = pageIndex * count and stops when fewer than `count` come back.
  skip: z.number().int().nonnegative(),
  count: z.number().int().positive().max(200),
});

export const CleanupErrorSchema = z.object({
  phase: z.enum(["teardown", "portPoolRelease"]),
  exitCode: z.number().nullable(),
  runId: z.string().min(1),
});
export type CleanupError = z.infer<typeof CleanupErrorSchema>;

export const DeleteWorktreeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), cleanupError: CleanupErrorSchema }),
]);
export type DeleteWorktreeResult = z.infer<typeof DeleteWorktreeResultSchema>;
