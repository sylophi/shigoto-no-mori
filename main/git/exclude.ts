// Helpers for appending to `.git/info/exclude`. The exclude file lives in
// the common git dir (shared across primary + worktrees), so patterns
// added here apply everywhere -- but they're anchored with a leading `/`
// to the worktree root, which means they only match at the top level.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Backslash-escape gitignore metacharacters so a literal path like
// `cache[dev]` or `build*` survives intact -- otherwise the glob would
// either fail to match the actual directory or sweep in unintended
// siblings, defeating the whole point of the exclude. `/` is the path
// separator and must stay raw; backslash itself goes first so we don't
// double-escape what we just added. Trailing spaces also need escaping
// because git silently strips them from patterns, so a directory named
// `cache ` would otherwise land as `/cache` and miss the real path.
export function escapeGitignorePattern(path: string): string {
  return path
    .replace(/\\/g, "\\\\")
    .replace(/([*?[\]#!])/g, "\\$1")
    .replace(/ (?= *$)/g, "\\ ");
}

// Appends paths to the common-dir's info/exclude, anchored at the
// worktree root with a leading slash so we don't match same-named files
// in nested directories. Skips entries that already exist verbatim.
export async function appendExcludes(
  gitCwd: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const { stdout } = await execFileP(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: gitCwd },
  );
  const raw = stdout.trim();
  const excludeFile = isAbsolute(raw) ? raw : join(gitCwd, raw);
  let existing = "";
  try {
    existing = await readFile(excludeFile, "utf8");
  } catch {
    // file doesn't exist yet -- info/ may or may not; mkdir below handles it
  }
  const existingLines = new Set(existing.split("\n"));
  const toAdd = paths
    .map((p) => `/${escapeGitignorePattern(p)}`)
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
