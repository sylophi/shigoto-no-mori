// Keeps a relative path inside the project root: no leading "/", no
// ".." segment under either separator, no NUL. The one definition the
// path schemas (config, changes, sync) and the shared-settings merge all
// check. Every consumer joins the path to a root or hands it to git, so
// a drive (`C:x`) or a leading "\" stays inside. A segment of dots and
// trailing spaces (`.. `, `...`) is refused on every OS: Windows reads
// it as "..", and the schema can't know which OS decodes it, nor which
// device a synced config lands on.
export function isSafeRelPath(p: string): boolean {
  return (
    !p.startsWith("/") &&
    !p.split(/[\\/]/).some((segment) => /^\.\.[. ]*$/.test(segment)) &&
    !p.includes("\0")
  );
}
