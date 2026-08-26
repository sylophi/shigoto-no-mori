import { z } from "zod";
import { isValidWorktreeDirName } from "../branches";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "./payloads";
import { GitRefNameSchema, isRealBranch } from "./project";

// Abbreviated commit hashes are produced by `git log %h` and travel back
// down into git argv (`git show <hash>`). Pinning them to hex is what
// stops a value like "--output=/tmp/x" from ever reaching a flag
// position, and it also drops rows a crafted commit subject forged into
// the log output.
// Up to 64 hex chars: in a sha256 object-format repo `%h` can emit up
// to 64 (core.abbrev=no, or any abbrev past 40), and capping at sha1's
// 40 would reject every record in that configuration, leaving the
// commit list empty.
const COMMIT_HASH_RE = /^[0-9a-f]{4,64}$/;

export const isCommitHash = (value: string): boolean =>
  COMMIT_HASH_RE.test(value);

export const CommitHashSchema = z
  .string()
  .regex(COMMIT_HASH_RE, { message: "Invalid commit hash" });

export const CommitSummarySchema = z.object({
  hash: CommitHashSchema,
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
  // The ref the "Sync from primary" action rebases onto -- the same ref
  // `behindPrimary` is measured against. Carries the remote prefix when
  // the primary resolves to a remote-tracking ref (e.g. "origin/main"),
  // so the renderer can show it on the pill without implying the source
  // is a local branch.
  primaryRef: z.string().optional(),
  // True when this branch's work is already in the primary branch. See
  // landedOnPrimary in host/lib/git/worktrees.ts for what does and
  // doesn't count -- notably a local fast-forward merge doesn't, since
  // its history is indistinguishable from a worktree that never
  // committed. False for the primary worktree and for detached HEAD.
  mergedIntoPrimary: z.boolean(),
  changedCount: z.number().int().nonnegative(),
  // Newest mtime across the worktree's uncommitted changes, epoch ms.
  // Absent when the tree is clean (or when the scan couldn't stat
  // anything). Exists so "recently worked in" can account for edits that
  // were never committed, not just the commit log.
  lastChangeAt: z.number().int().nonnegative().optional(),
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

// When the worktree last saw work, epoch ms, for recency sorting.
// Uncommitted edits count: a worktree you were typing in five minutes
// ago should outrank one whose last commit is newer but that you
// haven't touched since. 0 when nothing is known -- a clean worktree
// with no commits yet.
export function worktreeLastActivityAt(
  worktree: Pick<Worktree, "lastChangeAt" | "recentCommits">,
): number {
  const committed = Date.parse(worktree.recentCommits[0]?.date ?? "");
  return Math.max(
    worktree.lastChangeAt ?? 0,
    Number.isNaN(committed) ? 0 : committed,
  );
}

// A worktree this app created and owns, as opposed to the project's own
// checkout or one the user made by hand elsewhere. The flags that only
// apply to our own worktrees (shelving, relocating) key off this. Main
// enforces the same rule, so offering them elsewhere produces a no-op
// the UI then appears to ignore.
export function isManagedWorktree(
  worktree: Pick<Worktree, "isPrimary" | "isExternal">,
): boolean {
  return !worktree.isPrimary && !worktree.isExternal;
}

export const CreateWorktreePayloadSchema = ProjectScopedPayloadSchema.extend({
  // Optional: caller-picked animal dirname. Falls back to the backend's
  // own pick when omitted or when the requested name is already in use.
  // The refine backstops the renderer's sanitizing so reserved names
  // ("root", "..") never reach `git worktree add`.
  worktreeName: z
    .string()
    .min(1)
    .refine(isValidWorktreeDirName, { message: "Not a valid folder name" })
    .optional(),
  // Optional: when omitted, the worktree's auto-picked animal name is
  // used as the branch name too (the quick-create shortcut).
  branchName: GitRefNameSchema.optional(),
  base: GitRefNameSchema.optional(),
  // When true: check out `base` as the worktree's branch (no -b, no new
  // branch). Requires `base` to be set and not already checked out
  // elsewhere. Ignores `branchName`.
  checkout: z.boolean().optional(),
});

const CarryOverFailureSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export const CarryOverReportSchema = z.object({
  applied: z.number().int().nonnegative(),
  failures: z.array(CarryOverFailureSchema),
  // .worktreeinclude resolution errors. Not carry-over entries, so they
  // are reported separately from the per-entry failures above.
  includeFailures: z.array(CarryOverFailureSchema).optional(),
});

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

export const WorktreeLifecyclePhaseSchema = WorktreeScopedPayloadSchema.extend({
  phase: z.union([CreatePhaseSchema, z.literal("idle")]),
});
export type WorktreeLifecyclePhase = z.infer<
  typeof WorktreeLifecyclePhaseSchema
>;

export const WorktreeCarryOverCompleteSchema =
  WorktreeScopedPayloadSchema.extend({
    report: CarryOverReportSchema,
    // Manual carry-over entries auto-removed because .worktreeinclude now
    // covers them. Absent when reconciliation removed nothing.
    removedCarryOverPaths: z.array(z.string()).optional(),
  });
export type WorktreeCarryOverComplete = z.infer<
  typeof WorktreeCarryOverCompleteSchema
>;

export const RelocateWorktreePayloadSchema = WorktreeScopedPayloadSchema.extend(
  {
    // Absolute target directory for the moved worktree (parent is
    // created if it doesn't exist).
    destinationPath: z.string().min(1),
  },
);

export const DeleteWorktreePayloadSchema = WorktreeScopedPayloadSchema.extend({
  force: z.boolean().optional(),
  skipCleanup: z.boolean().optional(),
  // Refuse the delete outright (stable "scripts-running" message
  // marker) when the app's registry shows live scripts in the worktree,
  // instead of the default kill-then-delete. Set by the transplant
  // orchestrator, which must never take down work still running on the
  // source device. App-registry-only, so it never reaches `sm rm`.
  refuseRunningScripts: z.boolean().optional(),
});

export const RenameBranchPayloadSchema = WorktreeScopedPayloadSchema.extend({
  newBranch: GitRefNameSchema,
});

export const SetShelvedPayloadSchema = WorktreeScopedPayloadSchema.extend({
  shelved: z.boolean(),
});

export const CheckoutBranchPayloadSchema = WorktreeScopedPayloadSchema.extend({
  branch: GitRefNameSchema,
});

export const CommitDiffPayloadSchema = WorktreeScopedPayloadSchema.extend({
  hash: CommitHashSchema,
});

export const ListCommitsPayloadSchema = WorktreeScopedPayloadSchema.extend({
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
