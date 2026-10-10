import * as Schema from "effect/Schema";
import { isSafeRelPath } from "../predicates/relPath.ts";
import { WorktreeScopedPayloadSchema } from "./payloads.ts";
import { GitRefNameSchema } from "./project.ts";
import { CommitHashSchema, WorktreeSchema } from "./worktree.ts";

// How much of a changed file is in the index. The changes page doesn't
// tick from this (it keeps its own picks and stages them as it
// commits), but it tells a staged addition from an untracked file.
const StagedStateSchema = Schema.Literals(["none", "partial", "all"]);
export type StagedState = typeof StagedStateSchema.Type;

// What happened to the file, in git's own four buckets. Taken from the
// status codes rather than the patch: the patch answers a different
// question (how HEAD and the working tree differ, with renames paired
// across the two), and the changes page has to describe what a commit
// would record.
const ChangeKindSchema = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
]);
export type ChangeKind = typeof ChangeKindSchema.Type;

// Lines added and removed against HEAD. Absent for a binary file, where
// git won't say, so the row shows no counts rather than zeros.
const ChangeCountsSchema = Schema.Struct({
  additions: Schema.Natural,
  deletions: Schema.Natural,
});
export type ChangeCounts = typeof ChangeCountsSchema.Type;

export const ChangedFileSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  kind: ChangeKindSchema,
  // One field, so "either both numbers or neither" is the type's job
  // rather than something every reader re-checks.
  counts: Schema.optional(ChangeCountsSchema),
  // Present for a rename or copy recorded in the index: where the file
  // came from. Staging and discarding act on both paths.
  prevPath: Schema.optional(Schema.String),
  staged: StagedStateSchema,
  // An unmerged path. Nothing commits while one of these is around.
  conflicted: Schema.optional(Schema.Literal(true)),
});
export type ChangedFile = typeof ChangedFileSchema.Type;

// A row's identity. Two rows can name one path: `git rm --cached f`
// leaves a staged deletion and an untracked file, both called f, and
// they are separate decisions with separate diffs and separate counts.
// The kind tells them apart.
export function changeKey(file: ChangedFile): string {
  return `${file.kind} ${file.path}`;
}

// Git knows nothing about this file yet: it is in neither HEAD nor the
// index, so its diff compares against /dev/null and its counts can't
// come from `diff HEAD`. An unstaged addition is exactly what
// "untracked" means, so the two status letters say it on their own.
export function isUntracked(file: ChangedFile): boolean {
  return file.kind === "added" && file.staged === "none";
}

// Every path list travels into git argv after `--`, so a name that looks
// like a flag is never one. A remote peer sends whatever it likes, so
// paths are held to the worktree here: `git diff --no-index` reads any
// file it is pointed at.
export const RepoRelPathSchema = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (path: string) =>
      isSafeRelPath(path) || "Path must stay within the worktree",
  ),
);

const PathListSchema = Schema.Array(RepoRelPathSchema).check(
  Schema.isMinLength(1),
);

// The file whose diff to read: its path, with the old one first when
// git records a rename, and whether it is untracked. The caller has the
// status row in hand, and an empty diff can't answer "is this tracked":
// a staged edit reverted in the working tree is empty too, and reading
// that as a new file would show every line as an addition.
export const FileDiffPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  paths: PathListSchema,
  untracked: Schema.Boolean,
});

// A commit's message split the way the composer holds it: first line,
// then the body.
export const CommitMessageSchema = Schema.Struct({
  summary: Schema.String,
  description: Schema.String,
});
export type CommitMessage = typeof CommitMessageSchema.Type;

// Move the branch tip without touching the index or the working tree,
// so undone commits come back as staged changes. `target` must sit on
// HEAD's own history: behind it (an undo), or ahead of it when
// `expectHead` names the commit HEAD must still be on (the redo of an
// undo, refused once anything else has been committed).
export const ResetSoftPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  target: CommitHashSchema,
  expectHead: Schema.optional(CommitHashSchema),
});

export const ResetSoftResultSchema = Schema.Struct({
  // Where HEAD was before the move, what a redo resets back to.
  previousHead: CommitHashSchema,
  worktree: WorktreeSchema,
});
export type ResetSoftResult = typeof ResetSoftResultSchema.Type;

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
  // The commit the discarded content was snapshotted into before the
  // tree was reset (under refs/shigomori/discards/). Feed it back to
  // restoreDiscard to undo.
  snapshot: CommitHashSchema,
  worktree: WorktreeSchema,
});
export type DiscardChangesResult = typeof DiscardChangesResultSchema.Type;

export const RestoreDiscardPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  snapshot: CommitHashSchema,
});

// Rewrite a local commit's message, or fold it into the one before it.
// `expectHead` is the commit the list showed on top: the rewrite is
// refused once HEAD has moved past it.
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

// One stash made on the worktree's branch: its commit, the message it
// was given (`named`) or else the subject of the commit it was made on
// top of, and when.
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

// A git operation the worktree is stopped in (host/lib/git/operation.ts
// names them: "merge", "rebase", "cherry-pick", "revert", "squash",
// "git am", "bisect"), whether the app can continue it, and how many files still
// conflict. Conflicts can stand without an operation too, after a stash
// applied with them.
export const GitOperationStateSchema = Schema.Struct({
  operation: Schema.NullOr(Schema.String),
  continuable: Schema.Boolean,
  conflicted: Schema.Natural,
  // The branch a rebase is replaying, while git holds HEAD detached
  // for it. Null otherwise.
  rebasing: Schema.NullOr(Schema.String),
});
export type GitOperationState = typeof GitOperationStateSchema.Type;

export const ResolveConflictPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  path: RepoRelPathSchema,
  // "as-is" takes the file as it stands, settled in an editor.
  side: Schema.Literals(["mine", "theirs", "as-is"]),
});

// The ways another branch's work comes into the worktree's branch
// (host/lib/git/merge.ts): a merge commit, a fast-forward, one new
// commit holding it all, or the branch's own commits replayed on top.
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
});

// How the branch and the one to bring in stand: the commits each has
// that the other lacks, how many of the branch's own a remote has and
// how many are merges (a rebase rewrites the one and flattens the
// other), the files a merge of the two would leave conflicted, and the
// one commit coming in's subject, when one is (a squash's message to
// start from).
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
  // The squash's commit message.
  message: Schema.optional(Schema.Trim.check(Schema.isMinLength(1))),
});

// `stopped` when it waits on conflicts, for the Changes tab to settle.
export const MergeBranchResultSchema = Schema.Struct({
  worktree: WorktreeSchema,
  stopped: Schema.Boolean,
});
export type MergeBranchResult = typeof MergeBranchResultSchema.Type;

// One change of a zero-context diff of HEAD against the working tree,
// by its line ranges (hunk-header numbers). Identifies a hunk of a
// modified file for ticking and discarding it.
const LineChangeSchema = Schema.Struct({
  oldStart: Schema.Natural,
  oldCount: Schema.Natural,
  newStart: Schema.Natural,
  newCount: Schema.Natural,
});
export type LineChange = typeof LineChangeSchema.Type;

// The same change by its place in HEAD, which an edit elsewhere in the
// file leaves where it was. Its place in the working tree moves with
// every line added above it. How the page keeps a pick and how the
// commit finds it again.
export const sameRange = (a: LineChange, b: LineChange) =>
  a.oldStart === b.oldStart && a.oldCount === b.oldCount;

export const FileHunksPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  path: RepoRelPathSchema,
});

const LineChangeListSchema = Schema.Array(LineChangeSchema).check(
  Schema.isMinLength(1),
);

// A modified file's changes, and the HEAD they were read against: the
// one their places are counted in.
export const FileHunksSchema = Schema.Struct({
  head: CommitHashSchema,
  changes: Schema.Array(LineChangeSchema),
});
export type FileHunks = typeof FileHunksSchema.Type;

// What a commit takes, as the page has it ticked: whole files by path
// (both of a rename's), and the files ticked by hunk with the changes
// picked and the HEAD they were picked against. The index is set to
// exactly this first, so whatever was staged before (an agent's
// `git mv`, a terminal's `git add`) only goes in if it is ticked. The
// paths are what was on screen, not whatever landed in the tree since.
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
  // Rewrite HEAD instead of adding a commit on top of it.
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
