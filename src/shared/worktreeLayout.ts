// Pure path math for worktree layouts. Shared between the main process
// (where it backs createWorktree and the IPC handler) and the renderer
// (so the Worktree Location page can show accurate previews).
//
// Kept dependency-free so it can run in either environment.

import type { WorktreeLayout } from "./schemas";

const IN_PROJECT_SUBDIR = ".shigomori/worktrees";

// posix-style join: trims trailing slashes from `base`, then concatenates.
// Both main (node:path) and renderer call sites work with forward-slash
// paths on the platforms shigomori supports (macOS first; Linux later).
function joinPath(base: string, ...segments: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const seg of segments) {
    out += "/" + seg.replace(/^\/+/, "").replace(/\/+$/, "");
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
    if (trimmed) return trimmed.replace(/\/+$/, "");
  }
  const segments = projectPath.split("/");
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
