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

const pathSeparator = () => byPlatform({ darwin: ":", linux: ":", win32: ";" });

export const joinSearchPath = (dirs: ReadonlyArray<string>) =>
  dirs.join(pathSeparator());

// The extensions Windows runs a file by, lower-cased.
const pathExtensions = Effect.map(envVar("PATHEXT"), (exts) =>
  exts
    .toLowerCase()
    .split(";")
    .filter((ext) => ext !== ""),
);

const hasRunnableExtension = (file: string) =>
  Effect.map(pathExtensions, (exts) =>
    exts.some((ext) => file.toLowerCase().endsWith(ext)),
  );

// Where a program could be under each of PATH's directories, in the
// order they're tried. An empty entry is the working directory. Windows
// tries the name as given, then with each of PATHEXT's extensions.
export const candidatesOnPath = Effect.fnUntraced(function* (
  path: Path.Path,
  searched: string,
  name: string,
) {
  const exts = yield* pathExtensions;
  const fileNames = byPlatform({
    darwin: [name],
    linux: [name],
    win32: [name, ...exts.map((ext) => `${name}${ext}`)],
  });
  return searched
    .split(pathSeparator())
    .flatMap((dir) =>
      fileNames.map((fileName) => path.join(dir === "" ? "." : dir, fileName)),
    );
});

// Whether the OS would run the file: by its execute bits, and on
// Windows by its extension.
export const isRunnable = (file: string, mode: number) =>
  byPlatform({
    darwin: Effect.succeed((mode & 0o111) !== 0),
    linux: Effect.succeed((mode & 0o111) !== 0),
    win32: hasRunnableExtension(file),
  });

// The program's full path on `searched`, none when it has no such
// program.
export const findOn = Effect.fn("findOn")(function* (
  searched: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isFile = (candidate: string) =>
    fs.stat(candidate).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
  for (const candidate of yield* candidatesOnPath(path, searched, name)) {
    // Windows can't stat an app execution alias (a Store app's
    // WindowsApps entry), which still runs.
    const runnable =
      (yield* byPlatform({
        darwin: isFile(candidate),
        linux: isFile(candidate),
        win32: hasRunnableExtension(candidate),
      })) &&
      (yield* Effect.tryPromise(() => access(candidate, constants.X_OK)).pipe(
        Effect.isSuccess,
      ));
    if (runnable) return Option.some(candidate);
  }
  return Option.none<string>();
});

// The program's full path, none when PATH has no such program.
export const findExecutable = (name: string) =>
  Effect.flatMap(envVar("PATH"), (searched) => findOn(searched, name));
