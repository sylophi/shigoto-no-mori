import * as Schema from "effect/Schema";
import { RepoRelPathSchema } from "./changes.ts";
import { WorktreeScopedPayloadSchema } from "./payloads.ts";
import { strict } from "./strict.ts";

// Largest file the files page reads whole. Past this a file is a
// log, a bundle or a dump, which a read-only viewer has no business
// holding in memory on both ends of the wire (and highlighting).
export const WORKTREE_FILE_MAX_BYTES = 1024 * 1024;

// Largest image, video or audio file the files page reads whole. Larger
// than the text cap, since a short screen recording is already a few
// megabytes, and drawing it costs nothing like highlighting does. It
// crosses as base64 in one frame, which LINK_MAX_FRAME_BYTES (link.ts)
// is sized for.
export const WORKTREE_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

// One file of a worktree, by its path inside it, held to the worktree
// like every other path a peer sends.
export const ReadWorktreeFilePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  path: RepoRelPathSchema,
});

// One side of a binary file in a diff: the blob its patch's `index`
// line names, a full SHA-1 or SHA-256 id (every patch the host makes
// carries `--full-index`), and the path it had, which picks the media
// type and holds a blob git never stored. Only a full id, so a read
// names the exact blob a patch showed.
export const ReadBlobPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  oid: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
  path: RepoRelPathSchema,
});

// What the files page, or a side of a diff, can show for a path. Text
// travels, and so does media the renderer's Chromium can draw. Any other binary or oversized
// file answers with its size alone, and a path that went away between
// the listing and the read (or is no longer a plain file) says so
// rather than failing the query.
export const WorktreeFileSchema = Schema.Union([
  strict(
    Schema.Struct({
      kind: Schema.Literal("text"),
      contents: Schema.String,
      size: Schema.Natural,
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("media"),
      mime: Schema.String,
      base64: Schema.String,
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
