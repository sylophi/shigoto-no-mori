// Best-effort: failed entries are collected and returned so the caller
// can surface them, but they never abort worktree creation.

import { cp, lstat, mkdir, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CarryOverEntry, CarryOverFailure } from "@shared/schemas";

export interface CarryOverResult {
  applied: number;
  failures: CarryOverFailure[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
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
  if (await pathExists(dst)) {
    // Worktree creation just made this dir, so anything pre-existing is
    // something git itself put there (the branch tracks it). Don't overwrite.
    return { path: entry.path, reason: "Destination already exists" };
  }
  try {
    await mkdir(dirname(dst), { recursive: true });
    if (entry.mode === "symlink") {
      // Absolute target so the link survives moving the worktree dir around.
      await symlink(src, dst);
    } else {
      // force:false matters even though we pre-check pathExists — otherwise
      // a race between the check and cp would silently clobber files git
      // just laid down.
      await cp(src, dst, { recursive: true, force: false });
    }
    return null;
  } catch (err) {
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
