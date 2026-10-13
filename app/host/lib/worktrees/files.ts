// The files page's read: one file of one worktree, whole, for a
// read-only viewer. The folder side is listWorktreeFolder (carryOver.ts),
// which the page shares with the mirror dialog's picker.
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { errorCodeOf } from "@shared/errors";
import {
  WORKTREE_FILE_MAX_BYTES,
  WORKTREE_MEDIA_MAX_BYTES,
  type WorktreeFile,
} from "@shared/schemas";

// How far in a NUL byte marks a file as binary. The same window git
// uses for its own text/binary guess.
const BINARY_SNIFF_BYTES = 8000;

// The images, videos and audio the renderer's Chromium draws, by
// extension. SVG stays out: it is text, and its source is what a code
// viewer is for. A .mov goes as MP4, the container it shares: Chromium
// turns away video/quicktime even when it can play what's inside.
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

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
  const mime = MEDIA_TYPES[extname(path).toLowerCase()];
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
    const bytes = buffer.subarray(0, length);
    // A media extension on text (a Git LFS pointer whose object was
    // never pulled) shows the text.
    if (!bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { kind: "text", contents: bytes.toString("utf8"), size: length };
    }
    if (mime) {
      return {
        kind: "media",
        mime,
        base64: bytes.toString("base64"),
        size: length,
      };
    }
    return { kind: "binary", size: length };
  } finally {
    await handle.close();
  }
}

function isGoneError(err: unknown): boolean {
  const code = errorCodeOf(err);
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}
