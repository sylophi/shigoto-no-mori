import { Schema } from "effect";
import { isSafeRelPath } from "../git/gitPaths";
import { WorktreeScopedPayloadSchema } from "./payloads";
import { CommitHashSchema, WorktreeSchema } from "./worktree";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// How much of a changed file is in the index, i.e. what a commit right
// now would take from it. The changes page draws this as a checkbox:
// "all" ticked, "none" clear, "partial" indeterminate (hunks staged from
// a terminal. The app leaves those alone unless the box is toggled).
export const StagedStateSchema = Schema.Literals(["none", "partial", "all"]);
export type StagedState = typeof StagedStateSchema.Type;

// What happened to the file, in git's own four buckets. Taken from the
// status codes rather than the patch: the patch answers a different
// question (how HEAD and the working tree differ, with renames paired
// across the two), and the changes page has to describe what a commit
// would record.
export const ChangeKindSchema = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
]);
export type ChangeKind = typeof ChangeKindSchema.Type;

// Lines added and removed against HEAD. Absent for a binary file, where
// git won't say, so the row shows no counts rather than zeros.
export const ChangeCountsSchema = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
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
// The kind tells them apart and survives a tick, which moves `staged`
// and nothing else.
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
const RepoRelPathSchema = Schema.NonEmptyString.check(
  Schema.makeFilter(isSafeRelPath, {
    message: "Path must stay within the worktree",
  }),
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

export const SetStagedPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  paths: PathListSchema,
  staged: Schema.Boolean,
});

export const CommitChangesPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  summary: Schema.Trim.check(Schema.isNonEmpty()),
  description: Schema.optional(Schema.String),
  // Staged before the commit. When nothing is ticked the page sends
  // every path it listed, so "all of it" means what was on screen and
  // not whatever landed in the tree since.
  stagePaths: Schema.optional(Schema.Array(RepoRelPathSchema)),
  // Rewrite HEAD instead of adding a commit on top of it.
  amend: Schema.optional(Schema.Boolean),
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
