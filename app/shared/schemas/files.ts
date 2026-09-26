import { z } from "zod";
import { RepoRelPathSchema } from "./changes";
import { WorktreeScopedPayloadSchema } from "./payloads";

// Largest file the files page reads whole. Past this a file is a
// log, a bundle or a dump, which a read-only viewer has no business
// holding in memory on both ends of the wire (and highlighting).
export const WORKTREE_FILE_MAX_BYTES = 1024 * 1024;

// One file of a worktree, by its path inside it, held to the worktree
// like every other path a peer sends.
export const ReadWorktreeFilePayloadSchema = WorktreeScopedPayloadSchema.extend(
  { path: RepoRelPathSchema },
);

// What the files page can show for a path. Only text travels: a
// binary or oversized file answers with its size alone, and a path
// that went away between the listing and the read (or is no longer a
// plain file) says so rather than failing the query.
export const WorktreeFileSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    contents: z.string(),
    size: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("binary"),
    size: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("tooLarge"),
    size: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("missing") }),
]);
export type WorktreeFile = z.infer<typeof WorktreeFileSchema>;
