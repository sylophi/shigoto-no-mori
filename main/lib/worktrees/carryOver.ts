// Best-effort: failed entries are collected and returned so the caller
// can surface them, but they never abort worktree creation.

import { cp, mkdir, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CarryOverEntry, CarryOverFailure } from "@shared/schemas";
import { appendExcludes } from "../git/exclude";

export interface CarryOverResult {
  applied: number;
  failures: CarryOverFailure[];
}

interface ApplyOutcome {
  failure: CarryOverFailure | null;
  excludePath: string | null;
}

async function applyOne(
  sourcePath: string,
  destPath: string,
  entry: CarryOverEntry,
): Promise<ApplyOutcome> {
  const src = join(sourcePath, entry.path);
  const dst = join(destPath, entry.path);
  let srcIsDir: boolean;
  try {
    srcIsDir = (await stat(src)).isDirectory();
  } catch {
    return {
      failure: { path: entry.path, reason: "Source missing in main checkout" },
      excludePath: null,
    };
  }
  try {
    // react-doctor-disable-next-line react-doctor/async-defer-await -- mkdir is required by both branches below; moving it past the guard would duplicate it
    await mkdir(dirname(dst), { recursive: true });
    if (entry.mode === "symlink") {
      // Absolute target so the link survives moving the worktree dir
      // around.
      await symlink(src, dst);
      // Only directory symlinks need to be hidden from git: `git diff
      // --no-index` tries to recurse through the link and errors, leaving
      // the file with a "1 file changed" count but a blank diff body.
      // File symlinks render fine as a `120000` patch, so we leave them
      // visible as ordinary uncommitted changes.
      return { failure: null, excludePath: srcIsDir ? entry.path : null };
    }
    // force:false makes cp throw EEXIST instead of overwriting files git
    // just laid down (the branch already tracks them).
    await cp(src, dst, { recursive: true, force: false });
    return { failure: null, excludePath: null };
  } catch (err) {
    const code =
      err instanceof Error && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === "EEXIST" || code === "ERR_FS_CP_EEXIST") {
      return {
        failure: { path: entry.path, reason: "Destination already exists" },
        excludePath: null,
      };
    }
    return {
      failure: {
        path: entry.path,
        reason: err instanceof Error ? err.message : String(err),
      },
      excludePath: null,
    };
  }
}

export async function applyCarryOver(
  sourcePath: string,
  destPath: string,
  entries: CarryOverEntry[],
): Promise<CarryOverResult> {
  if (entries.length === 0) return { applied: 0, failures: [] };
  const outcomes = await Promise.all(
    entries.map((e) => applyOne(sourcePath, destPath, e)),
  );
  const failures: CarryOverFailure[] = [];
  const excludes: string[] = [];
  for (const o of outcomes) {
    if (o.failure !== null) failures.push(o.failure);
    if (o.excludePath !== null) excludes.push(o.excludePath);
  }
  // Single write coalesces concurrent symlink entries — no race on the file.
  await appendExcludes(destPath, excludes);
  return { applied: entries.length - failures.length, failures };
}
