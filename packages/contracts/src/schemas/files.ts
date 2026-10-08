import * as Schema from "effect/Schema";
import { RepoRelPathSchema } from "./changes.ts";
import { WorktreeScopedPayloadSchema } from "./payloads.ts";
import { strict } from "./strict.ts";

// Largest file the files page reads whole. Past this a file is a
// log, a bundle or a dump, which a read-only viewer has no business
// holding in memory on both ends of the wire (and highlighting).
export const WORKTREE_FILE_MAX_BYTES = 1024 * 1024;

// One file of a worktree, by its path inside it, held to the worktree
// like every other path a peer sends.
export const ReadWorktreeFilePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  path: RepoRelPathSchema,
});

// What the files page can show for a path. Only text travels: a
// binary or oversized file answers with its size alone, and a path
// that went away between the listing and the read (or is no longer a
// plain file) says so rather than failing the query.
export const WorktreeFileSchema = Schema.Union([
  strict(
    Schema.Struct({
      kind: Schema.Literal("text"),
      contents: Schema.String,
      size: Schema.Natural,
    }),
  ),
  strict(
    Schema.Struct({ kind: Schema.Literal("binary"), size: Schema.Natural }),
  ),
  strict(
    Schema.Struct({ kind: Schema.Literal("tooLarge"), size: Schema.Natural }),
  ),
  strict(Schema.Struct({ kind: Schema.Literal("missing") })),
]);
export type WorktreeFile = typeof WorktreeFileSchema.Type;
