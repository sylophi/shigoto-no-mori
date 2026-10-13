// The files page's read: one file of one worktree, whole, for a
// read-only viewer. The folder side is listWorktreeFolder (carryOver.ts),
// which the page shares with the mirror dialog's picker. The diffs read
// a binary file's two sides the same way, by their blob ids.
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorCodeOf } from "@shared/errors";
import { mediaTypeOf } from "@shared/mediaTypes";
import { run, runBytes, splitZ } from "@host/lib/git/core";
import {
  WORKTREE_FILE_MAX_BYTES,
  WORKTREE_MEDIA_MAX_BYTES,
  type WorktreeFile,
} from "@shared/schemas";

// How far in a NUL byte marks a file as binary. The same window git
// uses for its own text/binary guess.
const BINARY_SNIFF_BYTES = 8000;

// Follows symlinks, and reads inside .git when asked: this rides the
// command grant (the contract's note), and a peer holding it can
// already run anything on this machine, so fencing either off would
// guard nothing. The path itself is held to the worktree by the schema.
export async function readWorktreeFile(
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
export async function readGitBlob(
  cwd: string,
  oid: string,
  path: string,
): Promise<WorktreeFile> {
  const object = `${oid}^{blob}`;
  let size;
  try {
    size = Number(
      await run(cwd, ["cat-file", "-s", "--end-of-options", object]),
    );
  } catch {
    return readUnstoredBlob(cwd, oid, path);
  }
  const mime = mediaTypeOf(path);
  const maxBytes = mime ? WORKTREE_MEDIA_MAX_BYTES : WORKTREE_FILE_MAX_BYTES;
  if (size > maxBytes) return { kind: "tooLarge", size };
  const bytes = await runBytes(
    cwd,
    ["cat-file", "blob", "--end-of-options", object],
    { maxBuffer: maxBytes },
  );
  return classify(bytes, mime);
}

// The file on disk, when it hashes to the id asked for. Only by a full
// id, which the changes page's patch prints (getFileDiff's
// --full-index), and only for what git counts as the worktree's (no
// ignored .env) as the ungated diffs are, so no guess reaches a file.
// A symlink stays out too: a diff shows where it points, never what is
// there.
async function readUnstoredBlob(
  cwd: string,
  oid: string,
  path: string,
): Promise<WorktreeFile> {
  if (oid.length < 40) return { kind: "missing" };
  const listed = await run(cwd, [
    "--literal-pathspecs",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    path,
  ]).catch(() => "");
  if (!splitZ(listed).includes(path)) return { kind: "missing" };
  // Sized before hashing, which reads the whole file. Not a pipe either,
  // which would hold hash-object waiting for a writer.
  const info = await lstat(join(cwd, path)).catch(() => null);
  if (!info?.isFile() || info.size > WORKTREE_MEDIA_MAX_BYTES) {
    return { kind: "missing" };
  }
  const hash = await run(cwd, ["hash-object", "--", path]).catch(() => "");
  if (hash.trim() !== oid) return { kind: "missing" };
  return readWorktreeFile(cwd, path);
}

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
