// Finding a program on PATH, as a shell would: the first regular file
// under one of PATH's directories this process may execute.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { envVar } from "./environment.ts";
import { byPlatform } from "./platform.ts";

// The file a program of ours is built as.
export const programFile = (name: string) =>
  name + byPlatform({ darwin: "", linux: "", win32: ".exe" });

const pathSeparator = () => byPlatform({ darwin: ":", linux: ":" });

export const joinSearchPath = (dirs: ReadonlyArray<string>) =>
  dirs.join(pathSeparator());

// Where a program could be under each of PATH's directories, in the
// order they're tried. An empty entry is the working directory.
export const candidatesOnPath = (
  path: Path.Path,
  searched: string,
  name: string,
) => {
  const fileNames = byPlatform({ darwin: [name], linux: [name] });
  return searched
    .split(pathSeparator())
    .flatMap((dir) =>
      fileNames.map((fileName) => path.join(dir === "" ? "." : dir, fileName)),
    );
};

const hasExecuteBit = (mode: number) => (mode & 0o111) !== 0;

export const isRunnableMode = (mode: number) =>
  byPlatform({ darwin: hasExecuteBit, linux: hasExecuteBit })(mode);

// The program's full path, none when PATH has no such program.
export const findExecutable = Effect.fn("findExecutable")(function* (
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const searched = yield* envVar("PATH");
  for (const candidate of candidatesOnPath(path, searched, name)) {
    const runnable =
      (yield* fs.stat(candidate).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      )) &&
      (yield* Effect.tryPromise(() => access(candidate, constants.X_OK)).pipe(
        Effect.isSuccess,
      ));
    if (runnable) return Option.some(candidate);
  }
  return Option.none<string>();
});
