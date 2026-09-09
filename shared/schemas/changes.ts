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

export const ChangedFileSchema = z.object({
  path: z.string().min(1),
  kind: ChangeKindSchema,
  // Present for a rename or copy recorded in the index: where the file
  // came from. Staging and discarding act on both paths.
  prevPath: z.string().optional(),
  staged: StagedStateSchema,
  // An unmerged path. Nothing commits while one of these is around.
  conflicted: z.literal(true).optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

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

export const SetStagedPayloadSchema = WorktreeScopedPayloadSchema.extend({
  paths: PathListSchema,
  staged: z.boolean(),
});

export const CommitChangesPayloadSchema = WorktreeScopedPayloadSchema.extend({
  summary: z.string().trim().min(1),
  description: z.string().optional(),
  // Staged before the commit. The page sends every path it listed when
  // nothing is ticked: an empty selection means "all of it", the way a
  // fresh commit usually does -- and exactly the "it" that was on
  // screen, not whatever landed in the tree since.
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
