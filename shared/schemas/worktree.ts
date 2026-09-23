import { Effect, Schema } from "effect";
import { isValidWorktreeDirName } from "../git/branches";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "./payloads";
import { GitRefNameSchema, isRealBranch } from "./project";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

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

export const CommitHashSchema = Schema.String.check(
  Schema.isPattern(COMMIT_HASH_RE, { message: "Invalid commit hash" }),
);

export const CommitSummarySchema = Schema.Struct({
  hash: CommitHashSchema,
  subject: Schema.String,
  author: Schema.String,
  date: Schema.String,
  // Net additions/deletions across all files in this commit, parsed
  // from `git log --shortstat`. Zero for empty/merge commits.
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type CommitSummary = typeof CommitSummarySchema.Type;

export const WorktreeSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NonEmptyString,
  // The worktree's identity, the directory basename. Stable across branch
  // checkouts/renames; for shigomori-created worktrees it's a randomly
  // picked animal name.
  name: Schema.String,
  // The currently checked-out branch. A *property* of the worktree, not
  // its identity. May change via `git checkout` / `git branch -m`.
  branch: Schema.String,
  path: Schema.String,
  // Commits this worktree has that its upstream doesn't, and vice versa.
  // Both 0 when synced, when there's no upstream, or when HEAD is
  // detached. Consumers should check `hasUpstream` to disambiguate.
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  // True when the branch has an upstream configured AND that upstream
  // still resolves (i.e. `@{u}` works). False for detached HEAD, brand-
  // new local branches, or branches whose tracked remote was deleted.
  hasUpstream: Schema.Boolean,
  // True when the project has at least one git remote configured. Drives
  // whether "Publish" is offered as an action versus only as a hint.
  hasRemote: Schema.Boolean,
  // Only meaningful when ahead > 0 && behind > 0. True when a merge
  // probe (`git merge-tree --write-tree`) reports no conflicts. The
  // Pull-and-push action tries `git rebase @{u}` first (linear history)
  // and falls back to `git merge @{u}` if a per-commit replay would
  // conflict. The probe guarantees the merge will land.
  divergedClean: Schema.Boolean,
  // Commits the project's primary branch (resolved via the same logic
  // as the "default branch" picker) has that this worktree's HEAD does
  // not. 0 for the primary worktree, detached HEAD, or when the primary
  // ref can't be resolved. The UI uses > 0 as the gate for offering
  // the "Sync from primary" action.
  behindPrimary: NonNegativeInt,
  // How many of HEAD's newest commits exist on no remote-tracking ref
  // at all. Bounds what amend and undo may rewrite. Distinct from
  // `ahead`, which only measures the configured upstream.
  unpushedCount: NonNegativeInt,
  // The ref the "Sync from primary" action rebases onto, the same ref
  // `behindPrimary` is measured against. Carries the remote prefix when
  // the primary resolves to a remote-tracking ref (e.g. "origin/main"),
  // so the renderer can show it on the pill without implying the source
  // is a local branch.
  primaryRef: Schema.optional(Schema.String),
  // True when this branch's work is already in the primary branch. See
  // landedOnPrimary in host/lib/git/worktrees.ts for what does and
  // doesn't count. Notably a local fast-forward merge doesn't, since
  // its history is indistinguishable from a worktree that never
  // committed. False for the primary worktree and for detached HEAD.
  mergedIntoPrimary: Schema.Boolean,
  changedCount: NonNegativeInt,
  // Newest mtime across the worktree's uncommitted changes, epoch ms.
  // Absent when the tree is clean (or when the scan couldn't stat
  // anything). Exists so "recently worked in" can account for edits that
  // were never committed, not just the commit log.
  lastChangeAt: Schema.optional(NonNegativeInt),
  // Most-recent first. Empty when the worktree has no commits yet.
  // Bounded by the backend (currently 4) so the IPC payload stays
  // small: 3 for the teaser plus 1 extra to signal "more available".
  recentCommits: Schema.Array(CommitSummarySchema),
  // The repo's primary checkout. Shown in the UI for context but never
  // removable, since deleting it would mean detaching the project itself.
  isPrimary: Schema.Boolean,
  // True when the worktree lives outside shigomori's managed worktrees dir
  // (i.e. created manually or by another tool). Primary checkouts are also
  // technically external; the UI tags only non-primary externals.
  isExternal: Schema.Boolean,
  // True when HEAD points at a commit rather than a branch. In this case
  // `branch` holds the short commit hash, not a real branch name, so
  // rename is impossible and the UI styles it as a hash, not a branch.
  detached: Schema.Boolean,
  // User-driven "out of focus" flag. Filtered out of the sidebar's main
  // list by default but recoverable via the per-project "Show shelved"
  // toggle. The worktree itself is untouched on disk.
  shelved: Schema.Boolean,
  // User-driven "follow the remote" flag. While it is set, the app
  // fast-forwards this worktree onto its upstream after each of its
  // background fetches, as long as the worktree has no local commits,
  // no uncommitted or untracked changes and no app-started process.
  // Meant for the primary checkout and other branches only ever read
  // here. Defaults so a row from an older peer or CLI still parses.
  // (withDecodingDefault straight on the field, not after
  // Schema.optional: that order leaves the decoded key optional too.)
  autoPull: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
});
export type Worktree = typeof WorktreeSchema.Type;

// A worktree's relationship to its upstream, derived from the raw counts
// on Worktree. The renderer switches on `kind` to pick the right pill;
// the backend just reports facts so it stays dumb. "publish" covers
// both "no upstream / remote exists" and "no upstream / no remote",
// distinguished by `canPublish` so the UI can disable the button.
type RemoteSyncState =
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

// Whether the newest `count` commits exist on no remote, so they can
// be amended or undone without rewriting anything shared.
export function canRewriteCommits(
  worktree: Pick<Worktree, "unpushedCount">,
  count: number,
): boolean {
  return count <= worktree.unpushedCount;
}

// When the worktree last saw work, epoch ms, for recency sorting.
// Uncommitted edits count: a worktree you were typing in five minutes
// ago should outrank one whose last commit is newer but that you
// haven't touched since. 0 when nothing is known, like a clean
// worktree with no commits yet.
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

// Whether the worktree has a data file (notes, custom ports) of its own.
// The primary checkout lives at the project path, which never sits under
// a managed prefix, so it's flagged external. It's still ours to
// annotate. Only genuinely external worktrees (manual checkouts
// elsewhere) deliberately have no on-disk state.
export function hasWorktreeData(
  worktree: Pick<Worktree, "isPrimary" | "isExternal">,
): boolean {
  return !worktree.isExternal || worktree.isPrimary;
}

export const CreateWorktreePayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  // Optional: caller-picked animal dirname. Falls back to the backend's
  // own pick when omitted or when the requested name is already in use.
  // The refine backstops the renderer's sanitizing so reserved names
  // ("root", "..") never reach `git worktree add`.
  worktreeName: Schema.optional(
    Schema.NonEmptyString.check(
      Schema.makeFilter(isValidWorktreeDirName, {
        message: "Not a valid folder name",
      }),
    ),
  ),
  // Optional: when omitted, the worktree's auto-picked animal name is
  // used as the branch name too (the quick-create shortcut).
  branchName: Schema.optional(GitRefNameSchema),
  base: Schema.optional(GitRefNameSchema),
  // When true: check out `base` as the worktree's branch (no -b, no new
  // branch). Requires `base` to be set and not already checked out
  // elsewhere. Ignores `branchName`.
  checkout: Schema.optional(Schema.Boolean),
});

const CarryOverFailureSchema = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
  // The checkout the failure is about when it isn't the primary (a
  // sibling worktree's broken .worktreeinclude).
  source: Schema.optional(Schema.String),
});

export const CarryOverReportSchema = Schema.Struct({
  applied: NonNegativeInt,
  failures: Schema.Array(CarryOverFailureSchema),
  // .worktreeinclude resolution errors. Not carry-over entries, so they
  // are reported separately from the per-entry failures above.
  includeFailures: Schema.optional(Schema.Array(CarryOverFailureSchema)),
  // Entries taken from a worktree other than the primary (the CLI looks
  // in the base ref's worktree first, then the primary, then the rest).
  // copiedInstead: a symlink entry copied because links only ever
  // target the primary. Absent when everything came from the primary.
  sourced: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        source: Schema.String,
        copiedInstead: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});

export const CreateWorktreeResultSchema = Schema.Struct({
  worktree: WorktreeSchema,
});
export type CreateWorktreeResult = typeof CreateWorktreeResultSchema.Type;

// Phases the create lifecycle steps through, in order. Skipped if the
// phase has no work (no carry-over entries, no setup script, port-pool
// disabled). "idle" is the terminal sentinel emitted from `finally`.
const CREATE_PHASES = ["carryOver", "setup", "portPoolProvision"] as const;
export const CreatePhaseSchema = Schema.Literals(CREATE_PHASES);
export type CreatePhase = typeof CreatePhaseSchema.Type;

export const WorktreeLifecyclePhaseSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  phase: Schema.Literals([...CREATE_PHASES, "idle"]),
});
export type WorktreeLifecyclePhase = typeof WorktreeLifecyclePhaseSchema.Type;

export const WorktreeCarryOverCompleteSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  report: CarryOverReportSchema,
  // Manual carry-over entries auto-removed because .worktreeinclude now
  // covers them. Absent when reconciliation removed nothing.
  removedCarryOverPaths: Schema.optional(Schema.Array(Schema.String)),
});
export type WorktreeCarryOverComplete =
  typeof WorktreeCarryOverCompleteSchema.Type;

export const RelocateWorktreePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  // Absolute target directory for the moved worktree (parent is
  // created if it doesn't exist).
  destinationPath: Schema.NonEmptyString,
});

export const DeleteWorktreePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  force: Schema.optional(Schema.Boolean),
  skipCleanup: Schema.optional(Schema.Boolean),
  // Refuse the delete outright (stable "scripts-running" message
  // marker) when the app's registry shows live scripts in the worktree,
  // instead of the default kill-then-delete. Set by the transplant
  // orchestrator, which must never take down work still running on the
  // source device. App-registry-only, so it never reaches `sm rm`.
  refuseRunningScripts: Schema.optional(Schema.Boolean),
});

export const RenameBranchPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  newBranch: GitRefNameSchema,
});

export const SetShelvedPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  shelved: Schema.Boolean,
});

export const SetAutoPullPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  autoPull: Schema.Boolean,
});

export const CheckoutBranchPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  branch: GitRefNameSchema,
});

export const CommitDiffPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  hash: CommitHashSchema,
});

export const ListCommitsPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  // `git log --skip=N -n COUNT`; the renderer pages through with skip
  // = pageIndex * count and stops when fewer than `count` come back.
  skip: NonNegativeInt,
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
});

export const CleanupErrorSchema = Schema.Struct({
  phase: Schema.Literals(["teardown", "portPoolRelease"]),
  exitCode: Schema.NullOr(Schema.Finite),
  runId: Schema.NonEmptyString,
});
export type CleanupError = typeof CleanupErrorSchema.Type;

export const DeleteWorktreeResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    cleanupError: CleanupErrorSchema,
  }),
]);
export type DeleteWorktreeResult = typeof DeleteWorktreeResultSchema.Type;
