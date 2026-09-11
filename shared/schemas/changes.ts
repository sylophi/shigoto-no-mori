import { z } from "zod";
import { WorktreeScopedPayloadSchema } from "./payloads";
import { CommitHashSchema, WorktreeSchema } from "./worktree";

// How much of a changed file is in the index, i.e. what a commit right
// now would take from it. The changes page draws this as a checkbox:
// "all" ticked, "none" clear, "partial" indeterminate (hunks staged from
// a terminal. The app leaves those alone unless the box is toggled).
export const StagedStateSchema = z.enum(["none", "partial", "all"]);
export type StagedState = z.infer<typeof StagedStateSchema>;

// What happened to the file, in git's own four buckets. Taken from the
// status codes rather than the patch: the patch answers a different
// question (how HEAD and the working tree differ, with renames paired
// across the two), and the changes page has to describe what a commit
// would record.
export const ChangeKindSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
]);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

// Lines added and removed against HEAD. Absent for a binary file, where
// git won't say, so the row shows no counts rather than zeros.
export const ChangeCountsSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ChangeCounts = z.infer<typeof ChangeCountsSchema>;

export const ChangedFileSchema = z.object({
  path: z.string().min(1),
  kind: ChangeKindSchema,
  // One field, so "either both numbers or neither" is the type's job
  // rather than something every reader re-checks.
  counts: ChangeCountsSchema.optional(),
  // Present for a rename or copy recorded in the index: where the file
  // came from. Staging and discarding act on both paths.
  prevPath: z.string().optional(),
  staged: StagedStateSchema,
  // An unmerged path. Nothing commits while one of these is around.
  conflicted: z.literal(true).optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

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
// like a flag is never one. NUL is the one byte a path can't carry.
const PathListSchema = z
  .array(
    z
      .string()
      .min(1)
      .refine((p) => !p.includes("\0")),
  )
  .min(1);

// The file whose diff to read: its path, with the old one first when
// git records a rename, and whether it is untracked. The caller has the
// status row in hand, and an empty diff can't answer "is this tracked":
// a staged edit reverted in the working tree is empty too, and reading
// that as a new file would show every line as an addition.
export const FileDiffPayloadSchema = WorktreeScopedPayloadSchema.extend({
  paths: PathListSchema,
  untracked: z.boolean(),
});

export const SetStagedPayloadSchema = WorktreeScopedPayloadSchema.extend({
  paths: PathListSchema,
  staged: z.boolean(),
});

export const CommitChangesPayloadSchema = WorktreeScopedPayloadSchema.extend({
  summary: z.string().trim().min(1),
  description: z.string().optional(),
  // Staged before the commit. When nothing is ticked the page sends
  // every path it listed, so "all of it" means what was on screen and
  // not whatever landed in the tree since.
  stagePaths: z.array(z.string().min(1)).optional(),
  // Rewrite HEAD instead of adding a commit on top of it.
  amend: z.boolean().optional(),
});

// A commit's message split the way the composer holds it: first line,
// then the body.
export const CommitMessageSchema = z.object({
  summary: z.string(),
  description: z.string(),
});
export type CommitMessage = z.infer<typeof CommitMessageSchema>;

// Move the branch tip without touching the index or the working tree,
// so undone commits come back as staged changes. `target` must sit on
// HEAD's own history: behind it (an undo), or ahead of it when
// `expectHead` names the commit HEAD must still be on (the redo of an
// undo, refused once anything else has been committed).
export const ResetSoftPayloadSchema = WorktreeScopedPayloadSchema.extend({
  target: CommitHashSchema,
  expectHead: CommitHashSchema.optional(),
});

export const ResetSoftResultSchema = z.object({
  // Where HEAD was before the move, what a redo resets back to.
  previousHead: CommitHashSchema,
  worktree: WorktreeSchema,
});
export type ResetSoftResult = z.infer<typeof ResetSoftResultSchema>;

export const CommitChangesResultSchema = z.object({
  hash: CommitHashSchema,
  worktree: WorktreeSchema,
});
export type CommitChangesResult = z.infer<typeof CommitChangesResultSchema>;

export const DiscardChangesPayloadSchema = WorktreeScopedPayloadSchema.extend({
  paths: PathListSchema,
});

export const DiscardChangesResultSchema = z.object({
  // The commit the discarded content was snapshotted into before the
  // tree was reset (under refs/shigomori/discards/). Feed it back to
  // restoreDiscard to undo.
  snapshot: CommitHashSchema,
  worktree: WorktreeSchema,
});
export type DiscardChangesResult = z.infer<typeof DiscardChangesResultSchema>;

export const RestoreDiscardPayloadSchema = WorktreeScopedPayloadSchema.extend({
  snapshot: CommitHashSchema,
});
