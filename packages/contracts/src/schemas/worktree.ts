import * as Schema from "effect/Schema";
import { isValidWorktreeDirName } from "../predicates/worktreeDirName.ts";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "./payloads.ts";
import { WorktreeLayoutSchema } from "./config.ts";
import { GitRefNameSchema, isRealBranch } from "./project.ts";

// Hashes travel back into git argv, so hex keeps "--output=/tmp/x" out of
// a flag position and drops rows a crafted subject forged into the log.
// Up to 64: a sha256 repo's `%h` can emit that many.
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
  // A merge's are counted against its first parent.
  additions: Schema.Natural,
  deletions: Schema.Natural,
});
export type CommitSummary = typeof CommitSummarySchema.Type;

// at: when the state last changed, ms. tool and need: what a waiting
// session waits on. message: the one its last turn ended on.
const AgentSessionSchema = Schema.Struct({
  harness: Schema.String,
  session: Schema.String,
  state: Schema.Literals(["working", "waiting", "idle"]),
  at: Schema.Finite,
  title: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  need: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type AgentSession = typeof AgentSessionSchema.Type;

export const WorktreeSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NonEmptyString,
  // The directory basename: stable across branch changes.
  name: Schema.String,
  branch: Schema.String,
  path: Schema.String,
  // Both 0 without an upstream too: check `hasUpstream`.
  ahead: Schema.Natural,
  behind: Schema.Natural,
  // Configured and still resolving (`@{u}` works).
  hasUpstream: Schema.Boolean,
  hasRemote: Schema.Boolean,
  // When diverged: a merge probe found no conflicts, so a pull-and-push
  // can land (rebase first, else the merge the probe vouched for).
  divergedClean: Schema.Boolean,
  // Measured against primaryRef. 0 when that can't be resolved.
  behindPrimary: Schema.Natural,
  // HEAD's newest commits on no remote-tracking ref at all (unlike
  // `ahead`, which only measures the upstream): what amend and undo may
  // rewrite.
  unpushedCount: Schema.Natural,
  // With its remote prefix when remote-tracking ("origin/main").
  primaryRef: Schema.optional(Schema.String),
  // "main" for "origin/main", resolved with the remote list in hand, so
  // no client splits the ref.
  primaryBranch: Schema.optional(Schema.String),
  // A local fast-forward merge doesn't count: its history is
  // indistinguishable from a worktree that never committed.
  mergedIntoPrimary: Schema.Boolean,
  changedCount: Schema.Natural,
  // Newest mtime of the uncommitted changes, epoch ms.
  lastChangeAt: Schema.optional(Schema.Natural),
  // Epoch ms. Absent for the primary checkout.
  createdAt: Schema.optional(Schema.Natural),
  // Newest first, at most 4: 3 to show and 1 to signal more.
  recentCommits: Schema.Array(CommitSummarySchema),
  isPrimary: Schema.Boolean,
  // Outside the managed dir. True for the primary checkout too.
  isExternal: Schema.Boolean,
  // `branch` then holds the short commit hash.
  detached: Schema.Boolean,
  shelved: Schema.Boolean,
  // Fast-forward onto the upstream after each background fetch, while
  // there are no local commits, changes or app-started processes.
  autoPull: Schema.Boolean,
  agentWorking: Schema.optional(Schema.Boolean),
  agentSessions: Schema.optional(Schema.Array(AgentSessionSchema)),
  // What `sm describe` set; a pull request's take their place.
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
export type Worktree = typeof WorktreeSchema.Type;

// A worktree without its git probes (`sm worktrees list --identities`),
// the cheap read every worktree-scoped handler opens with. The fields are
// in the JSON's order, not the row's.
export const WorktreeIdentitySchema = Schema.Struct({
  id: WorktreeSchema.fields.id,
  projectId: WorktreeSchema.fields.projectId,
  name: WorktreeSchema.fields.name,
  branch: WorktreeSchema.fields.branch,
  path: WorktreeSchema.fields.path,
  isPrimary: WorktreeSchema.fields.isPrimary,
  isExternal: WorktreeSchema.fields.isExternal,
  detached: WorktreeSchema.fields.detached,
  shelved: WorktreeSchema.fields.shelved,
  autoPull: WorktreeSchema.fields.autoPull,
  agentWorking: WorktreeSchema.fields.agentWorking,
  primaryRef: WorktreeSchema.fields.primaryRef,
  primaryBranch: WorktreeSchema.fields.primaryBranch,
});
export type WorktreeIdentity = typeof WorktreeIdentitySchema.Type;

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

// Taking the remote's commits writes the tree, and picking a side of a
// split history throws one away, so those wait. No default: a new kind
// must say.
export function syncWaitsForCleanTree(state: RemoteSyncState): boolean {
  switch (state.kind) {
    case "detached":
    case "synced":
    case "publish":
    case "ahead":
      return false;
    case "behind":
    case "pullAndPush":
    case "diverged":
      return true;
  }
}

export function canRewriteCommits(
  worktree: Pick<Worktree, "unpushedCount">,
  count: number,
): boolean {
  return count <= worktree.unpushedCount;
}

// Uncommitted edits and agent session changes count too. The engine's
// idle shelf (shelf.ts lastTouchedAt) must read activity the same way.
export function worktreeLastActivityAt(
  worktree: Pick<Worktree, "lastChangeAt" | "recentCommits" | "agentSessions">,
): number {
  const committed = Date.parse(worktree.recentCommits[0]?.date ?? "");
  return Math.max(
    worktree.lastChangeAt ?? 0,
    Number.isNaN(committed) ? 0 : committed,
    ...(worktree.agentSessions ?? []).map((s) => s.at),
  );
}

// The engine applies the same rule to shelving and relocating.
export function isManagedWorktree(
  worktree: Pick<Worktree, "isPrimary" | "isExternal">,
): boolean {
  return !worktree.isPrimary && !worktree.isExternal;
}

// Once on, it stays switchable if the upstream vanishes, so it can be
// turned off.
export function canSetAutoPull(
  worktree: Pick<Worktree, "autoPull" | "hasUpstream" | "detached">,
): boolean {
  return worktree.autoPull || (worktree.hasUpstream && !worktree.detached);
}

export function isAgentWorking(
  worktree: Pick<Worktree, "agentWorking">,
  allowAgentWorking: boolean,
): boolean {
  return allowAgentWorking && worktree.agentWorking === true;
}

// The primary is flagged external but still keeps data.
export function hasWorktreeData(
  worktree: Pick<Worktree, "isPrimary" | "isExternal">,
): boolean {
  return !worktree.isExternal || worktree.isPrimary;
}

export const CreateWorktreePayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  // Picked by the engine when omitted or taken. The check keeps reserved
  // names ("root", "..") from `git worktree add`.
  worktreeName: Schema.optional(
    Schema.NonEmptyString.check(
      Schema.makeFilter(
        (name: string) =>
          isValidWorktreeDirName(name) || "Not a valid folder name",
      ),
    ),
  ),
  // Defaults to the worktree's name.
  branchName: Schema.optional(GitRefNameSchema),
  base: Schema.optional(GitRefNameSchema),
  // Check out `base` itself rather than branch from it.
  checkout: Schema.optional(Schema.Boolean),
  // false: git writes every file, no copy-on-write clone.
  cloneFiles: Schema.optional(Schema.Boolean),
});

const CarryOverFailureSchema = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
  source: Schema.optional(Schema.String),
});

export const CarryOverReportSchema = Schema.Struct({
  applied: Schema.Natural,
  failures: Schema.Array(CarryOverFailureSchema),
  includeFailures: Schema.optional(Schema.Array(CarryOverFailureSchema)),
  // Entries taken from a worktree other than the primary. copiedInstead:
  // a symlink entry copied, since links only target the primary.
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
export type CarryOverReport = typeof CarryOverReportSchema.Type;

export const CreateWorktreeResultSchema = Schema.Struct({
  worktree: WorktreeSchema,
});
export type CreateWorktreeResult = typeof CreateWorktreeResultSchema.Type;

// In order; a phase with no work is skipped.
export const CreatePhaseSchema = Schema.Literals([
  "carryOver",
  "setup",
  "portPoolProvision",
]);
export type CreatePhase = typeof CreatePhaseSchema.Type;

export const WorktreeLifecyclePhaseSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  phase: Schema.Union([CreatePhaseSchema, Schema.Literal("idle")]),
});
export type WorktreeLifecyclePhase = typeof WorktreeLifecyclePhaseSchema.Type;

// Announced to every window and peer: the list only drops the row once
// the delete resolves, so a worktree on its way out would otherwise read
// as ordinary to anyone who didn't start it.
export const WorktreeRemovalSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  state: Schema.Literals(["removing", "removed", "kept"]),
});
export type WorktreeRemoval = typeof WorktreeRemovalSchema.Type;

export const WorktreeCarryOverCompleteSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  report: CarryOverReportSchema,
  // Manual entries removed because .worktreeinclude now covers them.
  removedCarryOverPaths: Schema.optional(Schema.Array(Schema.String)),
});
export type WorktreeCarryOverComplete =
  typeof WorktreeCarryOverCompleteSchema.Type;

export const RelocateWorktreePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  destinationPath: Schema.NonEmptyString,
});

// A project's worktrees under a layout the location form proposes.
export const RelocationPlanPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  layout: WorktreeLayoutSchema,
  customPath: Schema.NullOr(Schema.String),
});

// Where a managed worktree would go under the proposed layout, and
// whether it is there already, by the folder's identity on the host.
export const RelocationPlanSchema = Schema.Array(
  Schema.Struct({
    worktreeId: Schema.String,
    destination: Schema.String,
    inPlace: Schema.Boolean,
  }),
);
export type RelocationPlan = typeof RelocationPlanSchema.Type;

export const RenameWorktreePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  name: Schema.NonEmptyString.check(
    Schema.makeFilter(
      (name: string) =>
        isValidWorktreeDirName(name) || "Not a valid folder name",
    ),
  ),
});

// force false refuses a worktree with changes or untracked files, read
// as it runs rather than off the row's count, which an edit since the
// list loaded leaves behind. Absent = forced.
export const ConvertExternalPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  force: Schema.optional(Schema.Boolean),
});

// What a transfer moved of its source, which the source's teardown
// must still hold at the delete: its branch at the tip it moved with,
// and its uncommitted work the tree the move captured (none: clean).
const MovedSourceSchema = Schema.Struct({
  branch: GitRefNameSchema,
  branchTip: CommitHashSchema,
  captureTree: Schema.optional(CommitHashSchema),
});
export type MovedSource = typeof MovedSourceSchema.Type;

export const DeleteWorktreePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  force: Schema.optional(Schema.Boolean),
  skipCleanup: Schema.optional(Schema.Boolean),
  // Refuse rather than kill live app scripts, for a transplant's
  // teardown.
  refuseRunningScripts: Schema.optional(Schema.Boolean),
  // A transplant's teardown (any other delete has none): refused, after
  // its cleanup and right before the delete, unless the source is still
  // what moved.
  expect: Schema.optional(MovedSourceSchema),
});

export const RenameBranchPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  newBranch: GitRefNameSchema,
});

// One left out stays as it is; an empty one clears it.
export const DescribeWorktreePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

export const SetShelvedPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  shelved: Schema.Boolean,
});

export const SetAutoPullPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  autoPull: Schema.Boolean,
});

export const AgentSessionPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  harness: Schema.NonEmptyString,
  session: Schema.NonEmptyString,
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
  skip: Schema.Natural,
  count: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(200),
  ),
  // Case blind.
  query: Schema.optional(Schema.Trim.check(Schema.isMinLength(1))),
  from: Schema.optional(CommitHashSchema),
});

export const BranchHistorySchema = Schema.Struct({
  commits: Schema.Array(CommitSummarySchema),
  more: Schema.Boolean,
  // Null for the primary, the primary branch and a detached HEAD, whose
  // commits are just HEAD's newest.
  base: Schema.NullOr(
    Schema.Struct({ ref: Schema.String, hash: CommitHashSchema }),
  ),
  upstream: Schema.NullOr(Schema.String),
  unpushed: Schema.Array(CommitHashSchema),
  incoming: Schema.Array(CommitSummarySchema),
  incomingMore: Schema.Boolean,
  upstreamFork: Schema.NullOr(CommitHashSchema),
  merges: Schema.Array(
    Schema.Struct({ hash: CommitHashSchema, firstParent: CommitHashSchema }),
  ),
});
export type BranchHistory = typeof BranchHistorySchema.Type;

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

// `worktreeId` is any worktree of the stack.
export const DeleteStackPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  force: Schema.optional(Schema.Boolean),
  skipCleanup: Schema.optional(Schema.Boolean),
});

export const DeleteStackResultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    removed: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    removed: Schema.Array(Schema.String),
    cleanupError: CleanupErrorSchema,
  }),
]);
export type DeleteStackResult = typeof DeleteStackResultSchema.Type;
