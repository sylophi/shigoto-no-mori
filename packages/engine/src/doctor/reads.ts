// The doctor's reads: the platform reads every check uses (a program's output, stat, realpath, a folder's entries).
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as Darwin from "../Darwin.ts";
import { isNotFound } from "../platformErrors.ts";
import { capture as runCapture } from "../processes.ts";

export const makeReads = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const darwin = yield* Darwin.Darwin;
  // A program's stdout and exit code. Fails when it can't be spawned.
  const capture = (
    command: string,
    args: ReadonlyArray<string>,
    env?: Record<string, string>,
  ) =>
    runCapture(spawner, command, args, { env }).pipe(
      Effect.map(({ output, code }) => ({ stdout: output, code })),
    );

  // lstat(2) of names in a folder, by name: a symlink's own, as Go's
  // directory entries tell them. What it can't answer is absent.
  const lstatIn = (dir: string, entries: ReadonlyArray<string>) =>
    entries.length === 0
      ? Effect.succeed(new Map<string, Darwin.LstatEntry>())
      : darwin.lstat({ root: dir, paths: entries }).pipe(
          Stream.runCollect,
          Effect.map(
            (found) =>
              new Map(
                found.flatMap((entry) =>
                  Darwin.isFailed(entry) ? [] : [[entry.path, entry] as const],
                ),
              ),
          ),
          Effect.orElseSucceed(() => new Map<string, Darwin.LstatEntry>()),
        );

  const statOf = (target: string) => fs.stat(target).pipe(Effect.option);

  const isDirectory = (target: string) =>
    Effect.map(
      statOf(target),
      (info) => Option.isSome(info) && info.value.type === "Directory",
    );

  const isMissing = (target: string) =>
    fs.stat(target).pipe(
      Effect.as(false),
      Effect.catchIf(isNotFound, () => Effect.succeed(true)),
      Effect.orElseSucceed(() => false),
    );

  const realPath = (target: string) => fs.realPath(target).pipe(Effect.option);

  // Whether two paths name the same directory once symlinks are gone.
  // False when either can't be resolved: "can't tell" isn't "same".
  const sameDirectory = (a: string, b: string) =>
    Effect.map(
      Effect.all([realPath(a), realPath(b)]),
      ([ra, rb]) =>
        Option.isSome(ra) && Option.isSome(rb) && ra.value === rb.value,
    );

  const readText = (target: string) =>
    fs.readFileString(target).pipe(Effect.option);

  const listDir = (dir: string) =>
    fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  return {
    capture,
    lstatIn,
    statOf,
    isDirectory,
    isMissing,
    realPath,
    sameDirectory,
    readText,
    listDir,
  };
});

export type ReadsArea = Effect.Success<typeof makeReads>;
