// The updater's files: the commands it runs, the files it shares with the app and a v2 sm, read leniently and written whole, the download's digest, and whether the app is running.
import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { programFile } from "../executables.ts";
import { type Flavor, flavorNames } from "../flavor.ts";
import { unitState } from "../hostUnit.ts";
import { parseJson } from "../json.ts";
import { linuxInstall } from "../linuxInstall.ts";
import * as Paths from "../Paths.ts";
import { byPlatform } from "../platform.ts";
import { exec, pidAlive } from "../processes.ts";
import * as ProcessTable from "../ProcessTable.ts";
import {
  type AppStatus,
  appStatusOf,
  type ReleaseInfo,
} from "../updateFeed.ts";
import {
  DigestRejected,
  type Ran,
  RemoveFailed,
  StagingFailed,
  type UpdateInput,
  report,
  updaterFiles,
} from "./documents.ts";

export const makeFiles = ({ flavor }: { readonly flavor: Flavor }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const paths = yield* Paths.Paths;
    const processTable = yield* ProcessTable.ProcessTable;
    // CFBundleExecutable of the app (forge names it for the flavor), which
    // survives bundle moves and renames, so it tells the app from a
    // process that got a recycled pid.
    const appExecutable = flavorNames(flavor).appName;
    const at = updaterFiles(path, paths.dataDir);
    const statusPath = at.status;
    const temporaries = yield* Ref.make(0);
    // A command run to the end, `from` its stdout or both its streams,
    // with `env` over this process's own. One that couldn't start reads
    // as a failure with no output.
    const run = (
      command: string,
      args: ReadonlyArray<string>,
      from: "stdout" | "all" = "all",
      env?: Record<string, string>,
    ) =>
      // A stuck codesign, ditto or open would leave a headless install
      // waiting for good, with the app closed.
      exec(command, args, {
        timeout: "5 minutes",
        all: from === "all",
        anyExit: true,
        env,
        extendEnv: true,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.map(({ stdout, code }): Ran => ({
          ok: code === 0,
          output: stdout,
          cause: new Error(`exit status ${code}`),
        })),
        Effect.catch((error) =>
          Effect.succeed<Ran>({
            ok: false,
            output: "",
            cause: error.cause ?? error,
          }),
        ),
      );

    // By rm, not FileSystem.remove: in the app, Electron's fs takes the
    // app.asar inside a bundle for a folder, so a recursive remove of an
    // .app fails on it, leaving a husk a rename onto then refuses.
    // Windows has no rm: there it is FileSystem.remove, which clears a
    // read-only file and takes a junction without what it names.
    const removeAll = (target: string) =>
      byPlatform({
        darwin: removeByRm,
        linux: removeByRm,
        win32: removeByFs,
      })(target);
    const removeByFs = (target: string) =>
      fs
        .remove(target, { recursive: true, force: true })
        .pipe(
          Effect.mapError((cause) => new RemoveFailed({ path: target, cause })),
        );
    const removeByRm = (target: string) =>
      run("rm", ["-rf", "--", target]).pipe(
        Effect.flatMap((ran) =>
          ran.ok
            ? Effect.void
            : Effect.fail(
                new RemoveFailed({
                  path: target,
                  cause:
                    ran.output.trim() === ""
                      ? ran.cause
                      : new Error(ran.output.trim()),
                }),
              ),
        ),
      );
    // A removal of what nothing needs gone: a leftover a later run
    // sweeps or clears, its failure no step's.
    const prune = (target: string) => removeAll(target).pipe(Effect.ignore);

    // A file the terminal, the app and a v2 Go sm share, read leniently: one
    // that is missing, unreadable or malformed reads as absent.
    const readShared = <A>(
      file: string,
      decode: (value: unknown) => Option.Option<A>,
    ) =>
      fs.readFileString(file).pipe(
        Effect.map((text) => Option.flatMap(parseJson(text), decode)),
        Effect.orElseSucceed(() => Option.none<A>()),
      );

    // Written whole through a temporary file beside it.
    const writeShared = Effect.fn("Updater.writeShared")(function* (
      file: string,
      text: string,
      pid: number,
    ) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      const now = yield* Clock.currentTimeMillis;
      const count = yield* Ref.getAndUpdate(temporaries, (n) => n + 1);
      const temporary = `${file}.tmp.${pid}.${now}.${count}`;
      yield* fs.writeFileString(temporary, text);
      yield* fs
        .rename(temporary, file)
        .pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)));
    });

    const hashOf = Effect.fnUntraced(function* (
      file: string,
      algorithm: "sha1" | "sha256",
    ) {
      const hash = createHash(algorithm);
      yield* Stream.runForEach(fs.stream(file), (chunk) =>
        Effect.sync(() => hash.update(chunk)),
      );
      return hash.digest("hex");
    });

    // The download holds to the digest its release names, read from
    // GitHub's API over HTTPS: the trust of a build with no signature to
    // check (Linux's, Windows').
    const checkDigest = Effect.fn("Updater.checkDigest")(function* (
      release: ReleaseInfo,
      input: UpdateInput,
    ) {
      const { version } = release;
      const download = at.download;
      yield* report(input, { phase: "verifying", version });
      if (!release.digest.startsWith("sha256:")) {
        yield* prune(download);
        return yield* new DigestRejected({ reason: "missing", version });
      }
      const digest = yield* hashOf(download, "sha256").pipe(
        Effect.mapError(
          (cause) =>
            new StagingFailed({ reason: "read", path: download, cause }),
        ),
      );
      if (`sha256:${digest}` !== release.digest) {
        yield* prune(download);
        return yield* new DigestRejected({ reason: "other", version });
      }
    });

    const makeDirectory = (target: string) =>
      fs
        .makeDirectory(target, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new StagingFailed({ reason: "directory", path: target, cause }),
          ),
        );

    // The host of a Linux install, as its unit runs it: none when the
    // service manager can't be asked.
    const unit = unitState(linuxInstall(flavor, paths)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.option,
    );

    // A live pid isn't yet the app: pids recycle across reboots, and handing
    // the install to a recycled one would wait on a process that never
    // restarts. On a Mac the executable's name has to match too, and ps
    // fails for a pid that is gone. On Linux it has to be the pid the
    // host's unit runs. On Windows its program has to be the app's.
    const appAlive = (pid: number) =>
      byPlatform({
        darwin: run("ps", ["-o", "comm=", "-p", String(pid)], "stdout").pipe(
          Effect.map((ps) => ps.ok && ps.output.includes(appExecutable)),
        ),
        linux: Effect.map(
          unit,
          (state) => Option.isSome(state) && state.value.pid === pid,
        ),
        win32: Effect.gen(function* () {
          if (!(yield* pidAlive(pid))) return false;
          return Option.exists(
            yield* processTable.identify(pid),
            ({ name }) => name === programFile(appExecutable),
          );
        }),
      });

    // The app running, even one that hasn't published updater.json yet:
    // any process with its executable's name (on a Mac the "... Helper"
    // processes don't count), on Linux the host's unit.
    const anyApp = processTable.running(programFile(appExecutable));
    const appRunning = byPlatform({
      darwin: anyApp,
      linux: Effect.map(
        unit,
        (state) => Option.isSome(state) && state.value.running,
      ),
      win32: anyApp,
    });

    // The app's updater.json, none when it is missing or malformed.
    const readStatus = readShared(statusPath, (value) =>
      Option.fromNullishOr(appStatusOf(value)),
    );

    const runningApp = Effect.gen(function* () {
      const status = yield* readStatus;
      if (Option.isNone(status) || !(yield* appAlive(status.value.pid))) {
        return Option.none<AppStatus>();
      }
      return status;
    });

    return {
      at,
      removeAll,
      prune,
      run,
      hashOf,
      checkDigest,
      makeDirectory,
      readShared,
      writeShared,
      appAlive,
      appRunning,
      readStatus,
      runningApp,
    };
  });

export type FilesArea = Effect.Success<ReturnType<typeof makeFiles>>;
