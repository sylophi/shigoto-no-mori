// The files page's read: one file of one worktree, whole, for a
// read-only viewer. The folder side is listWorktreeFolder (carryOver.ts),
// which the page shares with the mirror dialog's picker.
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorCodeOf } from "@shared/errors";
import { WORKTREE_FILE_MAX_BYTES, type WorktreeFile } from "@shared/schemas";

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
  if (info.size > WORKTREE_FILE_MAX_BYTES) {
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
    const buffer = Buffer.allocUnsafe(WORKTREE_FILE_MAX_BYTES + 1);
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
    if (length > WORKTREE_FILE_MAX_BYTES) {
      return { kind: "tooLarge", size: Math.max(length, info.size) };
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { kind: "binary", size: length };
    }
    return { kind: "text", contents: bytes.toString("utf8"), size: length };
  } finally {
    await handle.close();
  }
}

function isGoneError(err: unknown): boolean {
  const code = errorCodeOf(err);
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}
