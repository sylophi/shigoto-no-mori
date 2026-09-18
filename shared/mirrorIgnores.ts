// The engine patterns of the bring rule (shared/ipc/modules/sync.ts
// MirrorIgnoreModeSchema), built and read back. Free of imports so the
// smoke (scripts/e2e, plain node) can build the same patterns the app
// does.

// The cap on a session's ignore list.
export const MIRROR_IGNORES_LIMIT = 512;

// The bring rule's patterns: the gitignore rules, then a pair per
// brought path that takes it back out of them, `!/path` for the entry
// and `!/path/**` for what a folder holds (a bare-name rule like *.log
// would otherwise still catch a file inside). The engine never walks
// into an ignored folder, so a path only comes back when nothing above
// it is ignored: the picker offers the topmost ignored entry and no
// deeper. The pairs sit at the end, where the last match wins and
// where broughtPaths reads them back, and the rules give way to them
// under the cap.
export function bringIgnores(
  rules: readonly string[],
  brought: readonly string[],
): string[] {
  const pairs = brought
    .slice(0, MIRROR_IGNORES_LIMIT / 2)
    .flatMap((path) => [`!/${path}`, `!/${path}/**`]);
  return [...rules.slice(0, MIRROR_IGNORES_LIMIT - pairs.length), ...pairs];
}

// The brought paths of a bring rule's patterns, read back off the tail
// (a session only remembers its patterns).
export function broughtPaths(ignores: readonly string[]): string[] {
  const paths: string[] = [];
  for (let at = ignores.length - 2; at >= 0; at -= 2) {
    const entry = ignores[at];
    if (!entry.startsWith("!/") || ignores[at + 1] !== `${entry}/**`) break;
    paths.unshift(entry.slice(2));
  }
  return paths;
}
