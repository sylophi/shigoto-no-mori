// The engine patterns of the bring rule (shared/ipc/modules/sync.ts
// MirrorIgnoreModeSchema), built and read back. Free of imports so the
// smoke (test/e2e, plain node) can build the same patterns the app
// does.

// The cap on a session's ignore list.
export const MIRROR_IGNORES_LIMIT = 512;

// The most paths a bring rule names. Each costs two patterns out of
// the cap above, and the gitignore rules need the rest of it: a rule
// squeezed out is an ignored file that crosses.
export const BRING_PATHS_LIMIT = 64;

// What the engine's globs read as syntax. A picked path is a literal,
// so these are escaped on the way in: unescaped, `app/[id]` matches a
// folder named `i` or `d`, and a lone `[` fails the whole session.
const GLOB_SYNTAX = /[\\*?[\]{}]/g;

// An ignored path as `git ls-files` lists it (a fully ignored folder
// ends in a slash) as a root-anchored engine pattern, and back.
export function anchorIgnoredPath(path: string): string {
  return `/${path.replace(/\/+$/, "").replace(GLOB_SYNTAX, "\\$&")}`;
}
export function unanchorIgnoredPath(pattern: string): string {
  return pattern.replace(/^\//, "").replace(/\\(.)/g, "$1");
}

// Where a bring rule's gitignore rules end and its brought paths
// begin. A session only remembers its patterns, and the rules can end
// in lines shaped just like a brought pair (the `!/src`, `!/src/**` of
// an allowlist gitignore), so the boundary is a pattern of its own: a
// path inside .git, which the engine never scans, that no gitignore
// would name.
const BRING_MARKER = "/.git/shigomori-brought";

// How many gitignore rules fit beside this many brought paths.
export function bringRulesRoom(broughtCount: number): number {
  return (
    MIRROR_IGNORES_LIMIT - 1 - 2 * Math.min(broughtCount, BRING_PATHS_LIMIT)
  );
}

// The bring rule's patterns: the gitignore rules, the marker, then a
// pair per brought path that takes it back out of the rules, `!/path`
// for the entry and `!/path/**` for what a folder holds (a bare-name
// rule like *.log would otherwise still catch a file inside). The
// engine never walks into an ignored folder, so a path only comes back
// when nothing above it is ignored: the picker offers the topmost
// ignored entry and no deeper. The pairs come last because the last
// match wins.
export function bringIgnores(
  rules: readonly string[],
  brought: readonly string[],
): string[] {
  const pairs = brought
    .slice(0, BRING_PATHS_LIMIT)
    .map(anchorIgnoredPath)
    .flatMap((anchored) => [`!${anchored}`, `!${anchored}/**`]);
  return [
    ...rules.slice(0, bringRulesRoom(brought.length)),
    BRING_MARKER,
    ...pairs,
  ];
}

// The brought paths of a bring rule's patterns, read back from past
// the marker: the first of each pair, less its `!`.
export function broughtPaths(ignores: readonly string[]): string[] {
  const marker = ignores.lastIndexOf(BRING_MARKER);
  if (marker === -1) return [];
  return ignores
    .slice(marker + 1)
    .filter((_, at) => at % 2 === 0)
    .map((entry) => unanchorIgnoredPath(entry.slice(1)));
}
