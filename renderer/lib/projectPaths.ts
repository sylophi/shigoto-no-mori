// Path helpers for the add-project filesystem-browse flow. Ported
// from T3 Code's projectPaths.ts. On Windows both separator styles and
// drive-letter/UNC roots are understood, and a path is extended with the
// separator style it already uses so the user's input never flips under
// them. On POSIX only "/" separates -- a backslash is a legal filename
// character there.
import { comparablePath } from "@shared/worktreeLayout";
import { isWindows } from "./platform";

const TRAILING_SEPS = isWindows ? /[\\/]+$/ : /\/+$/;
const SPLIT_SEPS = isWindows ? /[\\/]/ : "/";
// "C:" -- a drive designator with nothing after it (post sep-trim form
// of the drive root "C:\").
const DRIVE_ONLY = /^[A-Za-z]:$/;
// "\\server" or "\\server\share" -- UNC hosts and share roots have no
// browsable parent. Either separator style: git porcelain reports UNC
// paths as "//server/share".
const UNC_ROOT = /^[\\/]{2}[^\\/]+([\\/][^\\/]+)?$/;

function lastSepIndex(value: string): number {
  const slash = value.lastIndexOf("/");
  if (!isWindows) return slash;
  return Math.max(slash, value.lastIndexOf("\\"));
}

// Separator to use when extending `value`: keep the style already in the
// string (Windows paths carry backslashes), default POSIX "/".
function sepStyle(value: string): "/" | "\\" {
  return isWindows && value.includes("\\") ? "\\" : "/";
}

export function hasTrailingSlash(value: string): boolean {
  const last = value.slice(-1);
  return last === "/" || (isWindows && last === "\\");
}

export function ensureTrailingSep(value: string): string {
  return hasTrailingSlash(value) ? value : `${value}${sepStyle(value)}`;
}

export function getBrowseDirectoryPath(value: string): string {
  if (hasTrailingSlash(value)) return value;
  const idx = lastSepIndex(value);
  if (idx < 0) return value;
  return value.slice(0, idx + 1);
}

export function getBrowseLeafSegment(value: string): string {
  return value.slice(lastSepIndex(value) + 1);
}

export function appendBrowsePathSegment(
  currentPath: string,
  segment: string,
): string {
  return `${getBrowseDirectoryPath(currentPath)}${segment}${sepStyle(currentPath)}`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const trimmed = currentPath.replace(TRAILING_SEPS, "");
  if (trimmed === "" || trimmed === "~") return null;
  if (isWindows) {
    // Drive roots ("C:\" trims to "C:") and UNC host/share roots have no
    // parent we can browse.
    if (DRIVE_ONLY.test(trimmed) || UNC_ROOT.test(trimmed)) return null;
  }
  const idx = lastSepIndex(trimmed);
  if (idx < 0) return null;
  if (idx === 0) {
    // "/foo" parents to the POSIX root; on Windows a drive-relative
    // "\foo" or "/foo" has no stable parent (it floats with the
    // process's current drive).
    return isWindows ? null : "/";
  }
  const parent = trimmed.slice(0, idx);
  // Sliced down to the drive designator: keep its separator so the
  // result stays an absolute root ("C:\"), not a drive-relative "C:".
  return `${parent}${sepStyle(currentPath)}`;
}

export function canNavigateUp(currentPath: string): boolean {
  return (
    hasTrailingSlash(currentPath) && getBrowseParentPath(currentPath) !== null
  );
}

export function normalizeForSubmit(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 1) return trimmed;
  const stripped = trimmed.replace(TRAILING_SEPS, "");
  // Don't strip a drive root down to the drive-relative form "C:".
  if (isWindows && DRIVE_ONLY.test(stripped)) {
    return `${stripped}${sepStyle(trimmed)}`;
  }
  return stripped;
}

export function tildify(path: string, home: string | null | undefined): string {
  if (!home || !path) return path;
  // comparablePath: on Windows the path often arrives git-style
  // ("C:/Users/…") while home is native ("C:\Users\…"); fold both so
  // the prefix still matches. Slicing by length is safe because the
  // folding preserves length.
  // Folding rewrites Windows separators to "/", so one prefix check
  // covers both input styles.
  const foldedPath = comparablePath(path);
  const foldedHome = comparablePath(home);
  if (foldedPath === foldedHome) return "~";
  if (foldedPath.startsWith(`${foldedHome}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

// Tildify, then progressively abbreviate middle segments to a single
// character (left to right) until the result fits within maxChars. The
// anchor ("~", leading "/...", or "C:") and the leaf (basename) stay
// intact so the identity at both ends is preserved. Returns the
// fully-abbreviated form when even that exceeds maxChars; callers can
// pair this with CSS truncate as a final floor.
export function tildifyAndShorten(
  path: string,
  home: string | null | undefined,
  maxChars: number,
): string {
  const tildified = tildify(path, home);
  if (tildified.length <= maxChars) return tildified;

  const sep = sepStyle(tildified);
  const parts = tildified.split(SPLIT_SEPS);
  if (parts.length < 3) return tildified;

  const anchor = parts[0];
  const leaf = parts[parts.length - 1];
  const middle = parts.slice(1, -1);
  if (middle.length === 0) return tildified;

  for (let i = 0; i < middle.length; i++) {
    const seg = middle[i];
    if (seg && seg.length > 1) middle[i] = seg.charAt(0);
    if ([anchor, ...middle, leaf].join(sep).length <= maxChars) break;
  }
  return [anchor, ...middle, leaf].join(sep);
}
