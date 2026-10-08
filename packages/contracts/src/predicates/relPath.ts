// Keeps a relative path inside the project root: no absolute paths, no
// ".." traversal, no NUL. The one definition the path schemas (config,
// changes, sync) and the shared-settings merge all check.
export function isSafeRelPath(p: string): boolean {
  return (
    !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && !p.includes("\0")
  );
}
