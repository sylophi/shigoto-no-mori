// Pure helpers for matching repo-relative paths against git's ignored-path
// listings. Shared so the renderer's carry-over picker and the main
// process's .worktreeinclude resolution agree on what "gitignored" means.

// A path is gitignored if it appears in the leaf list directly, if its
// directory form (path + "/") does, or if any ancestor folder is a fully
// ignored directory (entry with trailing slash). Mirrors how `git
// check-ignore` resolves nested paths against `--directory` output.
export function makeIgnoreMatcher(
  paths: string[],
): (relative: string) => boolean {
  const set = new Set(paths);
  return (relative) => {
    if (!relative) return false;
    if (set.has(relative)) return true;
    if (set.has(`${relative}/`)) return true;
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (set.has(`${parts.slice(0, i).join("/")}/`)) return true;
    }
    return false;
  };
}

// Collapse duplicate separators and trailing slashes before comparing
// stored entry paths against git output.
export function normalizeRelPath(p: string): string {
  return p
    .split("/")
    .filter((seg) => seg.length > 0)
    .join("/");
}

// Keeps a relative path inside the project root: no absolute paths, no
// ".." traversal, no NUL. Single source of truth for CarryOverEntrySchema
// and for main-side filtering of resolved .worktreeinclude paths (host/lib
// may only `import type` from the schemas barrel, so this lives here).
export function isSafeRelPath(p: string): boolean {
  return (
    !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && !p.includes("\0")
  );
}
