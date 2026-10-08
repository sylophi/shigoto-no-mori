// Keeps a relative path inside the project root: no absolute paths, no
// ".." traversal, no NUL. Single source of truth for CarryOverEntrySchema
// and for main-side filtering of resolved .worktreeinclude paths (host/lib
// may only `import type` from the schemas barrel, so this lives here).
export function isSafeRelPath(p: string): boolean {
  return (
    !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && !p.includes("\0")
  );
}
