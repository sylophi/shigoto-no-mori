// The doctor's reads: the platform reads every check uses (a program's output, stat, realpath, a folder's entries).
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NativeFs from "../NativeFs.ts";
import { parsePortPoolDirs } from "../doctorParse.ts";
import { findExecutable } from "../executables.ts";
import { isNotFound } from "../platformErrors.ts";
import { exec } from "../processes.ts";

export const makeReads = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nativeFs = yield* NativeFs.NativeFs;
  // A program run to its exit. A check waits on nothing longer: gh asks
  // GitHub, and a network that drops packets would hold the doctor for
  // good.
  const run = (command: string, args: ReadonlyArray<string>) =>
    exec(command, args, { timeout: "15 seconds" }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  // lstat(2) of names in a folder, by name: a symlink's own, as Go's
  // directory entries tell them. A name it can't answer is absent. The
  // helper failing fails the read, so a check says it couldn't look
  // rather than that nothing was there.
  const lstatIn = (dir: string, entries: ReadonlyArray<string>) =>
    NativeFs.lstatByPath(nativeFs, dir, entries);

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

  // What port-pool says, asked once a pass for the ports check and every
  // project's leases: off with the device's toggle, its program missing,
  // why `port-pool list` failed, or the folders it holds leases for.
  const portPoolListing = Effect.fnUntraced(function* (enabled: boolean) {
    if (!enabled) return { kind: "off" } as const;
    if (Option.isNone(yield* findExecutable("port-pool"))) {
      return { kind: "missing" } as const;
    }
    const listed = yield* run("port-pool", ["list"]).pipe(Effect.result);
    if (Result.isFailure(listed)) {
      const { failure } = listed;
      return {
        kind: "failed",
        why:
          failure.exitCode === null
            ? errorMessageOf(failure.cause ?? failure)
            : `exit status ${failure.exitCode}`,
      } as const;
    }
    return {
      kind: "listed",
      dirs: parsePortPoolDirs(listed.success.stdout),
    } as const;
  });

  return {
    run,
    portPoolListing,
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
export type PortPoolListing = Effect.Success<
  ReturnType<ReadsArea["portPoolListing"]>
>;
