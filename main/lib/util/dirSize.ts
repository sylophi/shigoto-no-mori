// Recursive directory measurement for the worktree hygiene surface.
//
// Deliberately implemented in Node rather than shelling out to `du`:
// `du` doesn't exist on Windows, and a bounded async walk measured the
// same speed as `du -sk` on a 470 MB / 32k-file checkout while returning
// the newest mtime in the same pass.
//
// Sizes come from `blocks * 512`, matching what `du` reports, so a
// sparse file or a small file in a big block doesn't inflate the total
// the way summing `size` would. Like `du` on a single path, a hardlinked
// file counts in full: a pnpm checkout links its packages into a global
// store, so some of what a worktree measures stays on disk after it is
// removed. Platforms that don't report `blocks`
// fall back to the apparent size.
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { createLimiter } from "./limit";

// Names whose contents are real disk usage but not evidence that anyone
// touched the worktree. A fresh `pnpm install` rewrites every mtime
// under node_modules, which would otherwise make an abandoned worktree
// look like it was worked on minutes ago.
//
// Matched against files as well as directories, which matters most for
// ".git": in a linked worktree that is a gitdir *pointer file* stamped
// at creation time, so counting it would make every worktree in the
// project look freshly active.
const ACTIVITY_EXCLUDED_NAMES = new Set([
  ".git",
  ".shigomori",
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  "__pycache__",
]);

// How many directories are read concurrently, across every walk in
// flight. Enough to keep the disk busy without risking EMFILE on a deep
// tree. The walk is IO-bound, so going wider stops helping well before
// this.
const readDirs = createLimiter(8);

export interface DirSizeResult {
  // Bytes occupied on disk across the whole tree.
  bytes: number;
  // Newest mtime (epoch ms) outside ACTIVITY_EXCLUDED_DIRS, or null when
  // nothing datable was found.
  lastActivityAt: number | null;
  // True when at least one entry couldn't be read, making `bytes` a
  // floor rather than an exact figure.
  partial: boolean;
}

interface PendingDir {
  path: string;
  // False once we descend into an excluded directory: everything below
  // still counts toward `bytes` but never toward `lastActivityAt`.
  countsAsActivity: boolean;
}

// Measures `root` recursively. Never follows symlinks (a link into a
// sibling worktree would double-count, and a cycle would hang), and
// never throws: unreadable entries are skipped and flagged via
// `partial` so the caller can render an approximate total instead of an
// error.
// `exclude` holds absolute directory paths to step over entirely. The
// in-project layout puts a project's worktrees *inside* its primary
// checkout, so without this the primary's walk counts every sibling's
// bytes as its own and the page's headline total doubles.
export async function measureDirectory(
  root: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<DirSizeResult> {
  let bytes = 0;
  let lastActivityAt: number | null = null;
  let partial = false;

  const noteFile = async (path: string, countsAsActivity: boolean) => {
    try {
      const stats = await lstat(path);
      bytes += stats.blocks != null ? stats.blocks * 512 : stats.size;
      if (countsAsActivity) {
        // Floor at the source: mtimeMs carries sub-millisecond precision,
        // and every timestamp we hand across IPC is a whole-millisecond
        // integer.
        const mtime = Math.floor(stats.mtimeMs);
        if (
          Number.isFinite(mtime) &&
          (lastActivityAt === null || mtime > lastActivityAt)
        ) {
          lastActivityAt = mtime;
        }
      }
    } catch {
      partial = true;
    }
  };

  // Reads one directory and returns the subdirectories to descend into.
  // Files are measured here. The caller owns the recursion, so no slot
  // is ever held while waiting on a child.
  const readDir = async (entry: PendingDir): Promise<PendingDir[]> => {
    const children: PendingDir[] = [];
    let dir;
    try {
      dir = await opendir(entry.path);
    } catch {
      partial = true;
      return children;
    }
    const files: Array<Promise<void>> = [];
    try {
      for await (const child of dir) {
        const childPath = join(entry.path, child.name);
        const countsAsActivity =
          entry.countsAsActivity && !ACTIVITY_EXCLUDED_NAMES.has(child.name);
        if (child.isSymbolicLink()) {
          // Count the link itself, never its target.
          files.push(noteFile(childPath, false));
          continue;
        }
        if (child.isDirectory()) {
          if (!exclude.has(childPath)) {
            children.push({ path: childPath, countsAsActivity });
          }
          continue;
        }
        if (child.isFile()) files.push(noteFile(childPath, countsAsActivity));
      }
    } catch {
      partial = true;
    }
    await Promise.all(files);
    return children;
  };

  // Descend breadth-first, with only the directory reads themselves
  // going through the limiter. Recursing inside a slot would deadlock the
  // moment a tree is deeper than the limit, and a fixed pool of workers
  // draining a shared queue has the opposite failure: every worker but
  // the first finds the queue empty on the tick it starts, returns, and
  // the walk runs single-file for the rest of its life.
  const descend = async (entry: PendingDir): Promise<void> => {
    const children = await readDirs(() => readDir(entry));
    await Promise.all(children.map((child) => descend(child)));
  };
  await descend({ path: root, countsAsActivity: true });

  // Floored for the same reason as the mtime above: the IPC schema takes
  // whole integers, and a platform reporting fractional blocks would
  // otherwise fail the boundary parse rather than the walk.
  return { bytes: Math.floor(bytes), lastActivityAt, partial };
}
