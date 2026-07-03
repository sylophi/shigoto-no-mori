// Pure path math for worktree layouts. Shared between the main process
// (where it backs createWorktree and the IPC handler) and the renderer
// (so the Worktree Location page can show accurate previews).
//
// Kept dependency-free so it can run in either environment.

import type { WorktreeLayout } from "./schemas";

// Project-relative directory used by the "in-project" layout. Top-level
// component (`.shigomori`) is also the path appended to the primary's
// `.git/info/exclude` so it stays out of `git status`.
export const IN_PROJECT_ROOT_DIR = ".shigomori";
export const IN_PROJECT_SUBDIR = `${IN_PROJECT_ROOT_DIR}/worktrees`;
export const ALL_WORKTREE_LAYOUTS: readonly WorktreeLayout[] = [
  "managed-root",
  "in-project",
  "custom",
];

// Dependency-free join that works in both main and the renderer (no
// node:path). A base counts as Windows-style only when it starts with a
// drive designator ("C:\" / "C:/") or a UNC prefix ("\\server\...") --
// a bare backslash elsewhere is NOT a separator signal, since it's a
// legal filename character on POSIX. Windows bases extend with the
// separator style they already use, so previews match what the main
// process will create.
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

function isWindowsStyle(base: string): boolean {
  return WINDOWS_DRIVE_PREFIX.test(base) || base.startsWith("\\\\");
}

function sepFor(base: string): "/" | "\\" {
  return isWindowsStyle(base) && base.includes("\\") ? "\\" : "/";
}

function joinPath(base: string, ...segments: string[]): string {
  const win = isWindowsStyle(base);
  const sep = sepFor(base);
  const sepClass = win ? /[\\/]+/ : /\/+/;
  let out = base.replace(win ? /[\\/]+$/ : /\/+$/, "");
  for (const seg of segments) {
    const parts = seg.split(sepClass).filter((p) => p.length > 0);
    for (const part of parts) out += sep + part;
  }
  return out;
}

interface LayoutInputs {
  layout: WorktreeLayout;
  projectPath: string;
  shigomoriRoot: string;
  customPath: string | null;
}

// Directory new worktrees should live under for the given layout. Custom
// without a path falls back to the managed root rather than producing an
// invalid path; the UI prevents saving an empty custom path.
export function worktreeBaseFor(inputs: LayoutInputs): string {
  const { layout, projectPath, shigomoriRoot, customPath } = inputs;
  if (layout === "in-project") {
    return joinPath(projectPath, IN_PROJECT_SUBDIR);
  }
  if (layout === "custom") {
    const trimmed = customPath?.trim();
    if (trimmed) {
      return trimmed.replace(isWindowsStyle(trimmed) ? /[\\/]+$/ : /\/+$/, "");
    }
  }
  const segments = projectPath.split(
    isWindowsStyle(projectPath) ? /[\\/]/ : "/",
  );
  const projectName = segments.findLast((s) => s.length > 0) ?? "";
  return joinPath(shigomoriRoot, "worktrees", projectName);
}

// Full destination path for a single worktree under the given layout.
export function worktreePathFor(
  inputs: LayoutInputs,
  worktreeName: string,
): string {
  return joinPath(worktreeBaseFor(inputs), worktreeName);
}
