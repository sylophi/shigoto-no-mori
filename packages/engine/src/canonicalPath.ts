import { byPlatform } from "./platform.ts";

// A path as the engine keeps, compares, hashes, stores and sends it: one
// spelling per folder, made where a path comes in (git's output, typed
// input, the OS). On macOS and Linux it is the OS's own spelling.
export const canonicalPath = (raw: string): string =>
  byPlatform({ darwin: asIs, linux: asIs, win32: windowsPath })(raw);

const asIs = (raw: string) => raw;

// Git for Windows' spelling: `/` separated, an upper-case drive letter,
// no `\\?\` prefix, and a trailing slash only on a root. A share's root
// is `//server/share`. Case is kept.
const windowsPath = (raw: string): string => {
  const path = raw
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "")
    .replace(/(?<!^)\/+/g, "/")
    .replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const trimmed = path.replace(/\/+$/, "");
  return trimmed !== path && /^([A-Z]:)?$/.test(trimmed)
    ? `${trimmed}/`
    : trimmed;
};
