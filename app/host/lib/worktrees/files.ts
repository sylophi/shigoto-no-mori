// The files page's read: one file of one worktree, whole, for a
// read-only viewer. The folder side is listWorktreeFolder (carryOver.ts),
// which the page shares with the mirror dialog's picker. The diffs read
// a binary file's two sides the same way, by their blob ids.
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorCodeOf } from "@shigomori/contracts/errors";
import { mediaTypeOf } from "@shigomori/contracts/mediaTypes";
import * as Git from "@shigomori/engine/Git";
import { errorWordsOf } from "@host/lib/errorWords";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  WORKTREE_FILE_MAX_BYTES,
  WORKTREE_MEDIA_MAX_BYTES,
  type WorktreeFile,
} from "@shigomori/contracts/schemas";

// How far in a NUL byte marks a file as binary. The same window git
// uses for its own text/binary guess.
const BINARY_SNIFF_BYTES = 8000;

// Follows symlinks, and reads inside .git when asked: this rides the
// command grant (the contract's note), and a peer holding it can
// already run anything on this machine, so fencing either off would
// guard nothing. The path itself is held to the worktree by the schema.
export const readWorktreeFile = (worktreePath: string, relative: string) =>
  Effect.tryPromise({
    try: () => readFileAt(worktreePath, relative),
    catch: (error) => new WorktreeFileError({ reason: errorWordsOf(error) }),
  });

// A file that could not be read for a reason other than its being gone.
class WorktreeFileError extends Schema.TaggedError<WorktreeFileError>()(
  "WorktreeFileError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

async function readFileAt(
  worktreePath: string,
  relative: string,
): Promise<WorktreeFile> {
  const path = join(worktreePath, relative);
  // Checked by path before anything opens it: opening a named pipe
  // waits for a writer that may never come, and a socket can't be
  // opened at all. A folder, pipe, socket or device reads as gone, since
  // the page only ever asks for what the listing showed as a file.
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (isGoneError(err)) return { kind: "missing" };
    throw err;
  }
  if (!info.isFile()) return { kind: "missing" };
  const mime = mediaTypeOf(path);
  const maxBytes = mime ? WORKTREE_MEDIA_MAX_BYTES : WORKTREE_FILE_MAX_BYTES;
  if (info.size > maxBytes) {
    return { kind: "tooLarge", size: info.size };
  }
  let handle;
  try {
    // Non-blocking, in case a pipe took the file's place since the stat.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    if (isGoneError(err)) return { kind: "missing" };
    throw err;
  }
  try {
    // One past the cap, so a file that grew since the stat shows up as
    // too large without being read (and held) whole.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      // oxlint-disable-next-line no-await-in-loop -- each read continues the last
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) {
      return { kind: "tooLarge", size: Math.max(length, info.size) };
    }
    return classify(buffer.subarray(0, length), mime);
  } finally {
    await handle.close();
  }
}

// One side of a binary file in a diff, by the blob id the patch names.
// `path` picks the media type, and stands in for a blob git never
// stored: a patch against the working tree names the file on disk by
// the id it would have. Missing when neither holds it (a pull request's
// head nobody fetched, a file saved again since).
export const readGitBlob = Effect.fn("readGitBlob")(function* (
  worktreePath: string,
  oid: string,
  path: string,
) {
  const git = yield* Git.Git;
  const mime = mediaTypeOf(path);
  const maxBytes = mime ? WORKTREE_MEDIA_MAX_BYTES : WORKTREE_FILE_MAX_BYTES;
  const blob = yield* git.readBlob({ repo: worktreePath, oid, maxBytes });
  if (Option.isSome(blob)) {
    const { size, bytes } = blob.value;
    return bytes === undefined
      ? ({ kind: "tooLarge", size } satisfies WorktreeFile)
      : classify(Buffer.from(bytes), mime);
  }
  const onDisk = yield* git.isWorkingTreeBlob({
    worktree: worktreePath,
    oid,
    path,
    maxBytes: WORKTREE_MEDIA_MAX_BYTES,
  });
  if (!onDisk) return { kind: "missing" } satisfies WorktreeFile;
  return yield* readWorktreeFile(worktreePath, path);
});

// What a file's bytes, already held to the media cap, can show as.
function classify(bytes: Buffer, mime: string | undefined): WorktreeFile {
  // A media extension on text (a Git LFS pointer whose object was
  // never pulled) shows the text, held to the text cap.
  if (
    bytes.length <= WORKTREE_FILE_MAX_BYTES &&
    !bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
  ) {
    return {
      kind: "text",
      contents: bytes.toString("utf8"),
      size: bytes.length,
    };
  }
  if (mime) {
    return {
      kind: "media",
      mime,
      base64: bytes.toString("base64"),
      size: bytes.length,
    };
  }
  return { kind: "binary", size: bytes.length };
}

function isGoneError(err: unknown): boolean {
  const code = errorCodeOf(err);
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}
