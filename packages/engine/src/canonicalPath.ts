import { resolve } from "node:path";
import { expandHome } from "@shigomori/contracts/projectPaths";
import { byPlatform } from "./platform.ts";

// A path as the engine keeps, compares, hashes, stores and sends it: one
// spelling per folder, made where a path comes in (git's output, typed
// input, the OS). On macOS and Linux it is the OS's own spelling.
export const canonicalPath = (raw: string): string =>
  byPlatform({ darwin: asIs, linux: asIs, win32: windowsPath })(raw);

const asIs = (raw: string) => raw;

// A typed path, canonical, with a leading `~` as `home`. On Windows one
// rooted without a drive (`/Users/me`) is on the current drive, and is
// spelled with it.
export const expandHomeAt = (home: string, typed: string) => {
  const path = expandHome(home, canonicalPath(typed));
  return byPlatform({
    darwin: () => path,
    linux: () => path,
    win32: () => (/^\/(?!\/)/.test(path) ? canonicalPath(resolve(path)) : path),
  })();
};

// Git for Windows' spelling: `/` separated, an upper-case drive letter,
// no `\\?\` or `\\.\` prefix before a drive or a share, and a trailing
// slash only on a root. A share's root is `//server/share`. Case is kept.
const windowsPath = (raw: string): string => {
  const path = raw
    .replaceAll("\\", "/")
    .replace(/^\/\/[?.]\/UNC\//i, "//")
    .replace(/^\/\/[?.]\/(?=[A-Za-z]:)/, "")
    .replace(/(?<!^)\/+/g, "/")
    .replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const trimmed = path.replace(/\/+$/, "");
  return trimmed !== path && /^([A-Z]:)?$/.test(trimmed)
    ? `${trimmed}/`
    : trimmed;
};
