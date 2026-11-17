// Windows' copy of a tree (../entries.ts), which has no cp.
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import * as Effect from "effect/Effect";
import { CopyFailed } from "./documents.ts";

// The tree is copied an entry at a time, so a cancel lands between two.
// A file keeps its attributes (git's read-only objects stay read-only)
// and its last write. A link to a folder by its absolute path is made
// again as a junction, which needs no privilege. A junction holds only
// an absolute path (pnpm links node_modules with them), so one into the
// tree is pointed into the copy where it lands (`landsAt`, which every
// caller renames it to), as a relative link would be. Any other
// link is a symbolic link, which needs Developer Mode or an elevated
// process, and without it fails the copy.
export const copyEntries = (
  from: string,
  to: string,
  landsAt: string,
  keepTimes: boolean,
) => {
  const step = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new CopyFailed({ to, cause }),
    });
  const entry = (
    source: string,
    target: string,
  ): Effect.Effect<void, CopyFailed> =>
    Effect.gen(function* () {
      const info = yield* step(() => lstat(source));
      if (info.isSymbolicLink()) {
        const named = yield* step(() => readlink(source));
        const folder = yield* Effect.promise(() =>
          stat(source).then(
            (found) => found.isDirectory(),
            () => false,
          ),
        );
        if (!folder || !isAbsolute(named)) {
          return yield* step(() =>
            symlink(named, target, folder ? "dir" : "file"),
          );
        }
        const inside = relative(from, named);
        const at =
          inside.startsWith("..") || isAbsolute(inside)
            ? named
            : join(landsAt, inside);
        return yield* step(() => symlink(at, target, "junction"));
      }
      if (!info.isDirectory()) {
        return yield* step(() =>
          copyFile(source, target, constants.COPYFILE_EXCL),
        );
      }
      yield* step(() => mkdir(target));
      for (const name of yield* step(() => readdir(source))) {
        yield* entry(join(source, name), join(target, name));
      }
      if (keepTimes) yield* step(() => utimes(target, info.atime, info.mtime));
    });
  return entry(from, to);
};
