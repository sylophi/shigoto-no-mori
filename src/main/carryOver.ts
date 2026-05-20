// Best-effort: failed entries are collected and returned so the caller
// can surface them, but they never abort worktree creation.

import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { CarryOverEntry, CarryOverFailure } from "@shared/schemas";

const execFileP = promisify(execFile);

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
  try {
    await stat(src);
  } catch {
    return {
      failure: { path: entry.path, reason: "Source missing in main checkout" },
      excludePath: null,
    };
  }
  try {
    await mkdir(dirname(dst), { recursive: true });
    if (entry.mode === "symlink") {
      // Absolute target so the link survives moving the worktree dir around.
      await symlink(src, dst);
      // Tell git to ignore this path: a symlink-to-directory would otherwise
      // surface as an untracked entry that `git diff --no-index` can't render
      // (it tries to recurse through the link), giving "1 file changed" with
      // a blank diff body. The symlink is shared state, never a change.
      return { failure: null, excludePath: entry.path };
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

// `info/exclude` lives in the common dir (shared across primary + worktrees).
// That's fine for carry-over: the picker is project-scoped, so every worktree
// already wants these paths ignored, and the primary doesn't have a symlink
// at the same path so the entry is a no-op there.
async function appendExcludes(
  worktreePath: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const { stdout } = await execFileP(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: worktreePath },
  );
  const raw = stdout.trim();
  const excludeFile = isAbsolute(raw) ? raw : join(worktreePath, raw);
  let existing = "";
  try {
    existing = await readFile(excludeFile, "utf8");
  } catch {
    // file doesn't exist yet -- info/ may or may not; mkdir below handles it
  }
  const existingLines = new Set(existing.split("\n"));
  // Leading slash anchors the pattern to the worktree root so we don't
  // accidentally swallow a same-named file in a nested directory.
  const toAdd = paths
    .map((p) => `/${p}`)
    .filter((line) => !existingLines.has(line));
  if (toAdd.length === 0) return;
  await mkdir(dirname(excludeFile), { recursive: true });
  const needsLeadingNewline =
    existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(
    excludeFile,
    `${existing}${needsLeadingNewline}${toAdd.join("\n")}\n`,
  );
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
  const failures = outcomes
    .map((o) => o.failure)
    .filter((f): f is CarryOverFailure => f !== null);
  const excludes = outcomes
    .map((o) => o.excludePath)
    .filter((p): p is string => p !== null);
  // Single write coalesces concurrent symlink entries — no race on the file.
  await appendExcludes(destPath, excludes);
  return { applied: entries.length - failures.length, failures };
}
