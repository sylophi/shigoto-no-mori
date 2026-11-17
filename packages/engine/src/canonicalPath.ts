// How a path is spelled. Each folder has one canonical spelling, the
// one kept, compared, hashed, stored and sent. On macOS and Linux it is
// the OS's own with a single leading "/", which is how the OS reads
// `//x`, so a stored path starting with `//` is always a Windows share.
// On Windows it is Git for Windows': `/` separated, an upper-case drive
// (`C:/`), a share as `//server/share`, no `\\?\` prefix, a trailing
// slash only on a root, case as the disk has it.
//
// A path is made canonical where it comes in, never where it is used.
// The Effect Path and FileSystem services answer canonical paths
// (canonicalPlatform.ts). Text from anywhere else (git's output, a
// `.git` file, an environment variable, the folder picker) goes through
// canonicalPath. Raw `node:path` and `process.*` results are not
// canonical on Windows: use the services, or where there are none this
// module's join, dirname, resolve and realpath. Typed text is
// read by the UI's devicePaths, then expandHomeAt. A receiver
// tells a Windows path by its spelling, never by the OS it runs on
// (contracts' projectPaths.ts), and a path under the home crosses
// devices from `~`. The native `\` spelling is only for a program that
// reads `/` as a switch.
//
// A relative path from a peer or a config is held to its root by
// isSafeRelPath (contracts' predicates/relPath.ts), the same rule on
// every OS, since a config roams to devices of the other kind.
import { realpathSync } from "node:fs";
import * as NodePath from "node:path";
import { expandHome } from "@shigomori/contracts/projectPaths";
import { byPlatform } from "./platform.ts";

export const canonicalPath = (raw: string): string =>
  byPlatform({ darwin: posixPath, linux: posixPath, win32: windowsPath })(raw);

export const join = (...paths: ReadonlyArray<string>) =>
  canonicalPath(NodePath.join(...paths));

export const dirname = (path: string) => canonicalPath(NodePath.dirname(path));

export const resolve = (...paths: ReadonlyArray<string>) =>
  canonicalPath(NodePath.resolve(...paths));

// The real path. On Windows the OS's own, as git resolves it
// (canonicalPlatform.ts).
export const realpath = (path: string) =>
  canonicalPath(
    byPlatform({
      darwin: realpathSync,
      linux: realpathSync,
      win32: realpathSync.native,
    })(path),
  );

const posixPath = (raw: string) => raw.replace(/^\/+/, "/");

// A typed path, canonical, with a leading `~` as `home`. On Windows one
// rooted without a drive (`/Users/me`) is on the current drive, and is
// spelled with it.
export const expandHomeAt = (home: string, typed: string) => {
  const path = expandHome(home, canonicalPath(typed));
  return byPlatform({
    darwin: () => path,
    linux: () => path,
    win32: () => (/^\/(?!\/)/.test(path) ? resolve(path) : path),
  })();
};

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
