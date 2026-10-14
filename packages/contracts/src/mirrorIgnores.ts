export const MIRROR_IGNORES_LIMIT = 512;

// Each costs two patterns of the cap, and the gitignore rules need the
// rest: a rule squeezed out is an ignored file that crosses.
export const BRING_PATHS_LIMIT = 64;

// Escaped on the way in: unescaped, `app/[id]` matches a folder named
// `i` or `d`, and a lone `[` fails the whole session.
const GLOB_SYNTAX = /[\\*?[\]{}]/g;

// A fully ignored folder ends in a slash.
export function anchorIgnoredPath(path: string): string {
  return `/${path.replace(/\/+$/, "").replace(GLOB_SYNTAX, "\\$&")}`;
}
export function unanchorIgnoredPath(pattern: string): string {
  return pattern.replace(/^\//, "").replace(/\\(.)/g, "$1");
}

// Rules can end in lines shaped just like a brought pair (an allowlist
// gitignore), so the boundary is its own pattern: a path inside .git,
// which the engine never scans.
const BRING_MARKER = "/.git/shigomori-brought";

export function bringRulesRoom(broughtCount: number): number {
  return (
    MIRROR_IGNORES_LIMIT - 1 - 2 * Math.min(broughtCount, BRING_PATHS_LIMIT)
  );
}

// Per brought path, `!/path` and `!/path/**` (a rule like *.log would
// otherwise still catch a file inside), last because the last match wins.
// The engine never walks into an ignored folder, so the picker offers
// only the topmost ignored entry.
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

export function broughtPaths(ignores: readonly string[]): string[] {
  const marker = ignores.lastIndexOf(BRING_MARKER);
  if (marker === -1) return [];
  return ignores
    .slice(marker + 1)
    .filter((_, at) => at % 2 === 0)
    .map((entry) => unanchorIgnoredPath(entry.slice(1)));
}
