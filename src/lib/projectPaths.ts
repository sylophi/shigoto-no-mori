// Unix-only path helpers for the filesystem-browse command palette mode.
// Ported from T3 Code's projectPaths.ts.

export function isFilesystemBrowseQuery(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  );
}

export function hasTrailingSlash(value: string): boolean {
  return value.endsWith("/");
}

export function getBrowseDirectoryPath(value: string): string {
  if (hasTrailingSlash(value)) return value;
  const idx = value.lastIndexOf("/");
  if (idx < 0) return value;
  return value.slice(0, idx + 1);
}

export function getBrowseLeafSegment(value: string): string {
  const idx = value.lastIndexOf("/");
  return value.slice(idx + 1);
}

export function appendBrowsePathSegment(
  currentPath: string,
  segment: string,
): string {
  return `${getBrowseDirectoryPath(currentPath)}${segment}/`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const trimmed = currentPath.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "~") return null;
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 0) return "/";
  return `${trimmed.slice(0, idx)}/`;
}

export function canNavigateUp(currentPath: string): boolean {
  return (
    hasTrailingSlash(currentPath) && getBrowseParentPath(currentPath) !== null
  );
}

export function normalizeForSubmit(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/\/+$/, "");
}

export function tildify(path: string, home: string | null | undefined): string {
  if (!home || !path) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

// Tildify, then progressively abbreviate middle segments to a single
// character (left to right) until the result fits within maxChars. The
// anchor ("~" or leading "/...") and the leaf (basename) stay intact so
// the identity at both ends is preserved. Returns the fully-abbreviated
// form when even that exceeds maxChars; callers can pair this with CSS
// truncate as a final floor.
export function tildifyAndShorten(
  path: string,
  home: string | null | undefined,
  maxChars: number,
): string {
  const tildified = tildify(path, home);
  if (tildified.length <= maxChars) return tildified;

  const parts = tildified.split("/");
  if (parts.length < 3) return tildified;

  const anchor = parts[0];
  const leaf = parts[parts.length - 1];
  const middle = parts.slice(1, -1);
  if (middle.length === 0) return tildified;

  for (let i = 0; i < middle.length; i++) {
    const seg = middle[i];
    if (seg && seg.length > 1) middle[i] = seg.charAt(0);
    if ([anchor, ...middle, leaf].join("/").length <= maxChars) break;
  }
  return [anchor, ...middle, leaf].join("/");
}
