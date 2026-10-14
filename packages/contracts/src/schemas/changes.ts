import * as Schema from "effect/Schema";
import { isSafeRelPath } from "../predicates/relPath.ts";
import { WorktreeScopedPayloadSchema } from "./payloads.ts";
import { GitRefNameSchema } from "./project.ts";
import { CommitHashSchema, WorktreeSchema } from "./worktree.ts";

// Not what the page ticks from (it keeps its own picks), but it tells a
// staged addition from an untracked file.
const StagedStateSchema = Schema.Literals(["none", "partial", "all"]);
export type StagedState = typeof StagedStateSchema.Type;

// From the status codes, not the patch: the page describes what a
// commit would record.
const ChangeKindSchema = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
]);
export type ChangeKind = typeof ChangeKindSchema.Type;

// Against HEAD. Absent for a binary file, where git won't say.
const ChangeCountsSchema = Schema.Struct({
  additions: Schema.Natural,
  deletions: Schema.Natural,
});
export type ChangeCounts = typeof ChangeCountsSchema.Type;

export const ChangedFileSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  kind: ChangeKindSchema,
  counts: Schema.optional(ChangeCountsSchema),
  // A rename or copy recorded in the index. Staging and discarding act
  // on both paths.
  prevPath: Schema.optional(Schema.String),
  staged: StagedStateSchema,
  // Nothing commits while one is around.
  conflicted: Schema.optional(Schema.Literal(true)),
});
export type ChangedFile = typeof ChangedFileSchema.Type;

// Two rows can name one path: `git rm --cached f` leaves a staged
// deletion and an untracked file, both called f.
export function changeKey(file: ChangedFile): string {
  return `${file.kind} ${file.path}`;
}

export function isUntracked(file: ChangedFile): boolean {
  return file.kind === "added" && file.staged === "none";
}

// Held to the worktree: a peer sends whatever it likes, and
// `git diff --no-index` reads any file it is pointed at.
export const RepoRelPathSchema = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (path: string) =>
      isSafeRelPath(path) || "Path must stay within the worktree",
  ),
);

const PathListSchema = Schema.Array(RepoRelPathSchema).check(
  Schema.isMinLength(1),
);

// The old path first for a rename. `untracked` comes from the caller's
// status row: an empty diff can't tell (a staged edit reverted in the
// tree is empty too).
export const FileDiffPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  paths: PathListSchema,
  untracked: Schema.Boolean,
});

export const CommitMessageSchema = Schema.Struct({
  summary: Schema.String,
  description: Schema.String,
});
export type CommitMessage = typeof CommitMessageSchema.Type;

// `target` must sit on HEAD's own history: behind it (an undo), or ahead
// when `expectHead` names where HEAD must still be (a redo).
export const ResetSoftPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  target: CommitHashSchema,
  expectHead: Schema.optional(CommitHashSchema),
});

export const ResetSoftResultSchema = Schema.Struct({
  previousHead: CommitHashSchema,
  worktree: WorktreeSchema,
});
export type ResetSoftResult = typeof ResetSoftResultSchema.Type;

// The undo puts the reset's snapshot back after (`restore`).
export const ResetHardPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  ref: GitRefNameSchema,
  expectHead: Schema.optional(CommitHashSchema),
  restore: Schema.optional(CommitHashSchema),
});

export const ResetHardResultSchema = Schema.Struct({
  previousHead: CommitHashSchema,
  head: CommitHashSchema,
  // The uncommitted files, for restoreDiscard.
  snapshot: Schema.NullOr(CommitHashSchema),
  worktree: WorktreeSchema,
});
export type ResetHardResult = typeof ResetHardResultSchema.Type;

export const CommitChangesResultSchema = Schema.Struct({
  hash: CommitHashSchema,
  worktree: WorktreeSchema,
});
export type CommitChangesResult = typeof CommitChangesResultSchema.Type;

export const DiscardChangesPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  paths: PathListSchema,
});

export const DiscardChangesResultSchema = Schema.Struct({
  // For restoreDiscard.
  snapshot: CommitHashSchema,
  worktree: WorktreeSchema,
});
export type DiscardChangesResult = typeof DiscardChangesResultSchema.Type;

export const RestoreDiscardPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  snapshot: CommitHashSchema,
});

// `expectHead`: what the list showed on top; refused once HEAD moved.
export const RewordCommitPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  hash: CommitHashSchema,
  summary: Schema.Trim.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.String),
  expectHead: CommitHashSchema,
});

export const SquashCommitPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  hash: CommitHashSchema,
  expectHead: CommitHashSchema,
});

// `message` is the one given (`named`), else the base commit's subject.
export const StashEntrySchema = Schema.Struct({
  hash: CommitHashSchema,
  message: Schema.String,
  named: Schema.Boolean,
  date: Schema.String,
});
export type StashEntry = typeof StashEntrySchema.Type;

export const StashChangesPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  message: Schema.optional(Schema.String),
});

// `drop` makes it a pop.
export const ApplyStashPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  hash: CommitHashSchema,
  drop: Schema.Boolean,
});

export const DropStashPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  hash: CommitHashSchema,
});

export const RestoreStashPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  hash: CommitHashSchema,
  message: Schema.String,
  named: Schema.Boolean,
});

// Conflicts can stand without an operation too, after a stash applied
// with them.
export const GitOperationStateSchema = Schema.Struct({
  operation: Schema.NullOr(Schema.String),
  continuable: Schema.Boolean,
  conflicted: Schema.Natural,
  // The branch a rebase is replaying, HEAD detached meanwhile.
  rebasing: Schema.NullOr(Schema.String),
});
export type GitOperationState = typeof GitOperationStateSchema.Type;

export const ResolveConflictPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  path: RepoRelPathSchema,
  side: Schema.Literals(["mine", "theirs", "as-is"]),
});

const IntegrateMethodSchema = Schema.Literals([
  "merge",
  "fastForward",
  "squash",
  "rebase",
]);
export type IntegrateMethod = typeof IntegrateMethodSchema.Type;

export const MergePreviewPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  ref: GitRefNameSchema,
  // Without the trial merge: no conflicts or subject, for a hard reset.
  countsOnly: Schema.optional(Schema.Boolean),
});

// `pushed` and `ownMerges`: what a rebase would rewrite and flatten.
// incomingSubject: when one commit comes in, a squash's message to start
// from.
export const MergePreviewSchema = Schema.Struct({
  incoming: Schema.Natural,
  own: Schema.Natural,
  pushed: Schema.Natural,
  ownMerges: Schema.Natural,
  // Null where git can't merge the two at all.
  conflicts: Schema.NullOr(Schema.Array(Schema.String)),
  incomingSubject: Schema.NullOr(Schema.String),
});
export type MergePreview = typeof MergePreviewSchema.Type;

export const MergeBranchPayloadSchema = Schema.Struct({
  ...MergePreviewPayloadSchema.fields,
  method: IntegrateMethodSchema,
  message: Schema.optional(Schema.Trim.check(Schema.isMinLength(1))),
});

export const MergeBranchResultSchema = Schema.Struct({
  worktree: WorktreeSchema,
  stopped: Schema.Boolean,
});
export type MergeBranchResult = typeof MergeBranchResultSchema.Type;

// A hunk of a zero-context diff of HEAD against the working tree.
const LineChangeSchema = Schema.Struct({
  oldStart: Schema.Natural,
  oldCount: Schema.Natural,
  newStart: Schema.Natural,
  newCount: Schema.Natural,
});
export type LineChange = typeof LineChangeSchema.Type;

// By its place in HEAD, which an edit elsewhere leaves where it was; its
// place in the working tree moves with every line added above.
export const sameRange = (a: LineChange, b: LineChange) =>
  a.oldStart === b.oldStart && a.oldCount === b.oldCount;

export const FileHunksPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  path: RepoRelPathSchema,
});

const LineChangeListSchema = Schema.Array(LineChangeSchema).check(
  Schema.isMinLength(1),
);

export const FileHunksSchema = Schema.Struct({
  head: CommitHashSchema,
  changes: Schema.Array(LineChangeSchema),
});
export type FileHunks = typeof FileHunksSchema.Type;

// The index is set to exactly this first, so what was staged before (an
// agent's `git mv`) only goes in if ticked.
const CommitPicksSchema = Schema.Struct({
  paths: Schema.Array(RepoRelPathSchema),
  hunks: Schema.Array(
    Schema.Struct({
      path: RepoRelPathSchema,
      base: CommitHashSchema,
      changes: LineChangeListSchema,
    }),
  ),
});
export type CommitPicks = typeof CommitPicksSchema.Type;

// An amend without a summary keeps HEAD's message as it is.
export const CommitChangesPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  summary: Schema.optional(Schema.Trim.check(Schema.isMinLength(1))),
  description: Schema.optional(Schema.String),
  ...CommitPicksSchema.fields,
  amend: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (payload: { amend?: boolean; summary?: string }) =>
      payload.amend === true ||
      payload.summary !== undefined ||
      "A commit needs a summary",
  ),
);

export const DiscardHunksPayloadSchema = Schema.Struct({
  ...FileHunksPayloadSchema.fields,
  changes: LineChangeListSchema,
});
