// Path helpers for the add-project filesystem-browse flow, and every
// surface that spells a folder the same way (the host's default clone
// place among them, shared/cloneDestination.ts). Ported from T3 Code's
// projectPaths.ts. Only "/" separates, since a backslash is a legal
// filename character on POSIX.

const TRAILING_SEPS = /\/+$/;

export function hasTrailingSlash(value: string): boolean {
  return value.endsWith("/");
}

export function ensureTrailingSep(value: string): string {
  return hasTrailingSlash(value) ? value : `${value}/`;
}

export function getBrowseDirectoryPath(value: string): string {
  if (hasTrailingSlash(value)) return value;
  const idx = value.lastIndexOf("/");
  if (idx < 0) return value;
  return value.slice(0, idx + 1);
}

export function getBrowseLeafSegment(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

export function appendBrowsePathSegment(
  currentPath: string,
  segment: string,
): string {
  return `${getBrowseDirectoryPath(currentPath)}${segment}/`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const trimmed = currentPath.replace(TRAILING_SEPS, "");
  if (
    trimmed === "" ||
    trimmed === "~" ||
    pathRoot(`${trimmed}/`) === `${trimmed}/`
  ) {
    return null;
  }
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  // "/foo" parents to the root.
  if (idx === 0) return "/";
  return `${trimmed.slice(0, idx)}/`;
}

export function canNavigateUp(currentPath: string): boolean {
  return (
    hasTrailingSlash(currentPath) && getBrowseParentPath(currentPath) !== null
  );
}

// Whether a typed path names a fixed spot on disk: absolute, or under
// the home folder. A bare relative path would resolve against whatever
// cwd the host process happens to have, which is never what the user
// meant when picking a folder.
export function isAnchoredPath(value: string): boolean {
  return pathRoot(value) !== "" || value === "~" || value.startsWith("~/");
}

export function normalizeForSubmit(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 1 || trimmed === pathRoot(trimmed)) return trimmed;
  return trimmed.replace(TRAILING_SEPS, "");
}

// The helpers below take a path as the engine spells it: `/` separated
// on every OS, so the same folder always hashes to the same id. A
// Windows path is told by its spelling, a drive (`C:/`) or a share
// (`//server/share`), not by the OS this runs on: a browser can show
// another device's paths.

// "/", a drive's "C:/" or a share's "//server/share/" for an absolute
// path, "" for a relative one.
function pathRoot(path: string): string {
  const share = /^\/\/[^/]+\/[^/]+(?=\/|$)/.exec(path)?.[0];
  if (share !== undefined) return `${share}/`;
  return /^([A-Za-z]:)?\//.exec(path)?.[0] ?? "";
}

const isWindowsPath = (path: string) =>
  /^([A-Za-z]:(\/|$)|\/\/[^/]+\/[^/])/.test(path);

export function trimTrailingSlashes(path: string): string {
  return path.replace(TRAILING_SEPS, "");
}

// Whether two paths name the same folder. Windows' file systems ignore
// case.
export function samePath(a: string, b: string): boolean {
  return isWindowsPath(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The part of `path` under `ancestor`, none when it isn't strictly under
// it. Neither side's trailing slash is dropped.
export function relativeInside(
  path: string,
  ancestor: string,
): string | undefined {
  return path[ancestor.length] === "/" &&
    samePath(path.slice(0, ancestor.length), ancestor)
    ? path.slice(ancestor.length + 1)
    : undefined;
}

// The whole subtree, as destructive flows guarding against it want.
// The engine's isManagedPath uses parent equality instead.
export function isSameOrInside(path: string, ancestor: string): boolean {
  const folded = trimTrailingSlashes(path);
  const base = trimTrailingSlashes(ancestor);
  return samePath(folded, base) || relativeInside(folded, base) !== undefined;
}

// The root is the first part's: `/` joined to `x` is `/x`, never a share.
export function joinPath(...parts: ReadonlyArray<string>): string {
  const [first = "", ...rest] = parts.filter((part) => part !== "");
  const root = pathRoot(first);
  const tail = [first.slice(root.length), ...rest].join("/");
  return cleanPath(`${root}${tail.replace(/^\/+/, "")}`);
}

export function lastSegment(path: string): string {
  return path.split("/").findLast((segment) => segment !== "") ?? "";
}

// A path as Go's filepath.Clean leaves it: `.` and `..` resolved, no
// doubled or trailing slash, and `.` for a relative path that resolves
// to nothing.
export function cleanPath(path: string): string {
  const root = pathRoot(path);
  const parts: string[] = [];
  for (const part of path.slice(root.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (root === "") parts.push("..");
  }
  const joined = parts.join("/");
  if (root === "") return joined || ".";
  // A share's root is spelled without its last slash.
  return joined === "" && root.startsWith("//")
    ? root.slice(0, -1)
    : `${root}${joined}`;
}

// A `~` or `~/` path joined to `home` and cleaned as Go's filepath.Join
// cleans it, and any other path as it is.
export function expandHome(home: string, path: string): string {
  if (!/^~(\/|$)/.test(path)) return path;
  return joinPath(home, path.slice(2));
}

export function tildify(path: string, home: string | null | undefined): string {
  if (!home || !path) return path;
  if (samePath(path, home)) return "~";
  const inside = relativeInside(path, home);
  return inside === undefined ? path : `~/${inside}`;
}

// Tildify, then progressively abbreviate middle segments to a single
// character (left to right) until the result fits within maxChars. A
// hidden folder keeps its dot and the character after it, as fish's
// prompt does: `.` alone would read as the current folder. The
// anchor ("~" or the leading "/...") and the leaf (basename) stay
// intact so the identity at both ends is preserved. Returns the
// fully-abbreviated form when even that exceeds maxChars, which callers
// can pair with CSS truncate as a final floor.
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

  for (let i = 0; i < middle.length; i++) {
    const seg = middle[i];
    if (seg) middle[i] = seg.startsWith(".") ? seg.slice(0, 2) : seg.charAt(0);
    if ([anchor, ...middle, leaf].join("/").length <= maxChars) break;
  }
  return [anchor, ...middle, leaf].join("/");
}
