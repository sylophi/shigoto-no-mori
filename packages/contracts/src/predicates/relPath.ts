// Keeps a relative path inside the project root: no leading slash of
// either kind, no drive (`C:x`), no ".." segment under either separator
// (with the `.. ` and `...` Windows reads as ".."), no NUL. The one
// definition the path schemas (config, changes, sync) and the
// shared-settings merge all check.
export function isSafeRelPath(p: string): boolean {
  return (
    !/^([\\/]|[A-Za-z]:)/.test(p) &&
    !p.split(/[\\/]/).some((segment) => /^\.\.[. ]*$/.test(segment)) &&
    !p.includes("\0")
  );
}
