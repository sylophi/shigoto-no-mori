// Recursive directory measurement for the worktree hygiene surface.
//
// Deliberately implemented in Node rather than shelling out to `du`:
// `du` doesn't exist on Windows, and a bounded async walk measured the
// same speed as `du -sk` on a 470 MB / 32k-file checkout while returning
// the newest mtime in the same pass.
//
// Sizes come from `blocks * 512`, matching what `du` reports, so a
// sparse file or a small file in a big block doesn't inflate the total
// the way summing `size` would. Platforms that don't report `blocks`
// fall back to the apparent size.
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

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

// How many directories are read concurrently. Enough to keep the disk
// busy without risking EMFILE on a deep tree; the walk is IO-bound, so
// going wider stops helping well before this.
const DIR_CONCURRENCY = 8;

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
export async function measureDirectory(root: string): Promise<DirSizeResult> {
  const queue: PendingDir[] = [{ path: root, countsAsActivity: true }];
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

  const readDir = async (entry: PendingDir) => {
    let dir;
    try {
      dir = await opendir(entry.path);
    } catch {
      partial = true;
      return;
    }
    try {
      for await (const child of dir) {
        const childPath = join(entry.path, child.name);
        const countsAsActivity =
          entry.countsAsActivity && !ACTIVITY_EXCLUDED_NAMES.has(child.name);
        if (child.isSymbolicLink()) {
          // Count the link itself, never its target.
          await noteFile(childPath, false);
          continue;
        }
        if (child.isDirectory()) {
          queue.push({ path: childPath, countsAsActivity });
          continue;
        }
        if (child.isFile()) await noteFile(childPath, countsAsActivity);
      }
    } catch {
      partial = true;
    }
  };

  // Drain the queue with a fixed number of workers. Each worker pops the
  // next directory until nothing is left, so newly discovered
  // subdirectories are picked up by whichever worker frees up first.
  const worker = async () => {
    for (;;) {
      const next = queue.pop();
      if (!next) return;
      // Sequential by design: this worker is one of DIR_CONCURRENCY
      // running in parallel, and awaiting here is what bounds the fan-out.
      await readDir(next); // oxlint-disable-line no-await-in-loop -- bounded worker pool
    }
  };
  await Promise.all(Array.from({ length: DIR_CONCURRENCY }, () => worker()));

  // Floored for the same reason as the mtime above: the IPC schema takes
  // whole integers, and a platform reporting fractional blocks would
  // otherwise fail the boundary parse rather than the walk.
  return { bytes: Math.floor(bytes), lastActivityAt, partial };
}
