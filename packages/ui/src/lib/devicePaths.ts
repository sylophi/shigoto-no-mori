// How a device's paths read and type for its people. The engine spells
// every path with `/` (the model: packages/engine/src/canonicalPath.ts).
// A Windows device's show with `\`, take either when typed, and browse up
// from a drive's root to "/", where its host lists the drives. A device
// is told by its home's spelling, and by the path's only when its home
// is unknown: a typed `//x` is a share on Windows and `/x` elsewhere.
import {
  appendBrowsePathSegment,
  getBrowseDirectoryPath,
  getBrowseParentPath,
  isAnchoredPath,
  isWindowsPath,
  tildify,
  tildifyAndShorten,
} from "@shigomori/contracts/projectPaths";

export interface DevicePaths {
  // A path as the screen shows it.
  readonly show: (path: string) => string;
  // A typed, pasted or picked path, as the engine spells it.
  readonly read: (typed: string) => string;
  // The folder a browse goes up to, null at the top.
  readonly parentOf: (path: string) => string | null;
  // The folder a browse goes into.
  readonly childOf: (path: string, name: string) => string;
  // Whether a typed path names a folder to pick.
  readonly isFolder: (path: string) => boolean;
}

const POSIX: DevicePaths = {
  show: (path) => path,
  read: (typed) => typed.replace(/^\/+/, "/"),
  parentOf: getBrowseParentPath,
  childOf: appendBrowsePathSegment,
  isFolder: isAnchoredPath,
};

const WINDOWS: DevicePaths = {
  show: (path) => path.replaceAll("/", "\\"),
  read: (typed) => typed.replaceAll("\\", "/"),
  parentOf: (path) =>
    getBrowseParentPath(path) ?? (isWindowsPath(path) ? "/" : null),
  childOf: (path, name) =>
    getBrowseDirectoryPath(path) === "/"
      ? `${name}/`
      : appendBrowsePathSegment(path, name),
  // A path rooted without a drive is on whichever drive the host is.
  isFolder: (path) =>
    isWindowsPath(path) || (isAnchoredPath(path) && !path.startsWith("/")),
};

export function devicePaths(
  home: string | null | undefined,
  path = "",
): DevicePaths {
  return isWindowsPath(home || path) ? WINDOWS : POSIX;
}

// A path as the screen shows it, in full.
export function shownFullPath(path: string, home: string | null | undefined) {
  return devicePaths(home, path).show(path);
}

// A path as the screen shows it, from `~` when it is in the home.
export function shownPath(path: string, home: string | null | undefined) {
  return devicePaths(home, path).show(tildify(path, home));
}

// The same, abbreviated to fit `maxChars` (tildifyAndShorten).
export function shownShortPath(
  path: string,
  home: string | null | undefined,
  maxChars: number,
) {
  return devicePaths(home, path).show(tildifyAndShorten(path, home, maxChars));
}
