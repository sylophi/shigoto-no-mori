// Best-effort: failed entries are collected and returned so the caller
// can surface them, but they never abort worktree creation.

import { cp, mkdir, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CarryOverEntry, CarryOverFailure } from "@shared/schemas";

export interface CarryOverResult {
  applied: number;
  failures: CarryOverFailure[];
}

async function applyOne(
  sourcePath: string,
  destPath: string,
  entry: CarryOverEntry,
): Promise<CarryOverFailure | null> {
  const src = join(sourcePath, entry.path);
  const dst = join(destPath, entry.path);
  try {
    await stat(src);
  } catch {
    return { path: entry.path, reason: "Source missing in main checkout" };
  }
  try {
    await mkdir(dirname(dst), { recursive: true });
    if (entry.mode === "symlink") {
      // Absolute target so the link survives moving the worktree dir around.
      await symlink(src, dst);
    } else {
      // force:false makes cp throw EEXIST instead of overwriting files git
      // just laid down (the branch already tracks them).
      await cp(src, dst, { recursive: true, force: false });
    }
    return null;
  } catch (err) {
    const code =
      err instanceof Error && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === "EEXIST" || code === "ERR_FS_CP_EEXIST") {
      return { path: entry.path, reason: "Destination already exists" };
    }
    return {
      path: entry.path,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function applyCarryOver(
  sourcePath: string,
  destPath: string,
  entries: CarryOverEntry[],
): Promise<CarryOverResult> {
  if (entries.length === 0) return { applied: 0, failures: [] };
  const results = await Promise.all(
    entries.map((e) => applyOne(sourcePath, destPath, e)),
  );
  const failures = results.filter((r): r is CarryOverFailure => r !== null);
  return { applied: entries.length - failures.length, failures };
}
