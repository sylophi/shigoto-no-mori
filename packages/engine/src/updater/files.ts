// The updater's files: the commands it runs, and the files it shares with the app and a v2 sm, read leniently and written whole.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { type Flavor, flavorNames } from "../flavor.ts";
import { parseJson } from "../json.ts";
import * as Paths from "../Paths.ts";
import { captureWithin } from "../processes.ts";
import { type AppStatus, appStatusOf } from "../updateFeed.ts";
import { NotInBundle, type Ran, updaterFiles } from "./documents.ts";

export const makeFiles = ({ flavor }: { readonly flavor: Flavor }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const paths = yield* Paths.Paths;
    // CFBundleExecutable of the app (forge names it for the flavor), which
    // survives bundle moves and renames, so it tells the app from a
    // process that got a recycled pid.
    const appExecutable = flavorNames(flavor).appName;
    const at = updaterFiles(path, paths.dataDir);
    const statusPath = at.status;
    const temporaries = yield* Ref.make(0);
    // A command run to the end, `from` its stdout or both its streams.
    // One that couldn't start reads as a failure with no output.
    const run = (
      command: string,
      args: ReadonlyArray<string>,
      from: "stdout" | "all" = "all",
    ) =>
      // A stuck codesign, ditto or open would leave a headless install
      // waiting for good, with the app closed.
      captureWithin(spawner, command, args, "5 minutes", { from }).pipe(
        Effect.map(
          ({ output, code }): Ran => ({
            ok: code === 0,
            output,
            cause: new Error(`exit status ${code}`),
          }),
        ),
        Effect.catch((cause) =>
          Effect.succeed<Ran>({ ok: false, output: "", cause }),
        ),
      );

    // By rm, not FileSystem.remove: in the app, Electron's fs takes the
    // app.asar inside a bundle for a folder, so a recursive remove of an
    // .app fails on it, leaving a husk a rename onto then refuses
    // (v3.0.0-alpha.4 to alpha.6 never staged an update).
    const removeAll = (target: string) =>
      run("rm", ["-rf", "--", target]).pipe(Effect.asVoid);

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

    // Written whole through a temporary file beside it, as the Go sm wrote.
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

    // A live pid isn't yet the app: pids recycle across reboots, and handing
    // the install to a recycled one would wait on a process that never
    // restarts. The executable's name has to match too, and ps fails for a
    // pid that is gone.
    const appAlive = (pid: number) =>
      run("ps", ["-o", "comm=", "-p", String(pid)], "stdout").pipe(
        Effect.map((ps) => ps.ok && ps.output.includes(appExecutable)),
      );

    // Any process with the app's executable name, even one that hasn't
    // published updater.json yet. -x matches exactly, so the "... Helper"
    // processes don't count.
    const appRunning = run("pgrep", ["-x", appExecutable]).pipe(
      Effect.map((ran) => ran.ok),
    );

    // The app's updater.json, none when it is missing or malformed.
    const readStatus = readShared(statusPath, (value) =>
      Option.fromNullishOr(appStatusOf(value)),
    );

    // The running app instance, when there is one.
    const runningApp = Effect.gen(function* () {
      const status = yield* readStatus;
      if (Option.isNone(status) || !(yield* appAlive(status.value.pid))) {
        return Option.none<AppStatus>();
      }
      return status;
    });

    // The installed bundle: two folders above the terminal's binary, which
    // runs from <bundle>/Contents/Resources (the command on PATH links
    // there). Anything else refuses, so a stray copy never swaps
    // /Applications.
    const installedBundle = Effect.fn("Updater.installedBundle")(function* (
      executable: string,
    ) {
      const resolved = yield* fs
        .realPath(executable)
        .pipe(Effect.orElseSucceed(() => executable));
      const resources = path.dirname(resolved);
      const contents = path.dirname(resources);
      const bundle = path.dirname(contents);
      if (
        path.basename(resources) !== "Resources" ||
        path.basename(contents) !== "Contents" ||
        !bundle.endsWith(".app")
      ) {
        return yield* new NotInBundle();
      }
      return bundle;
    });

    return {
      at,
      removeAll,
      run,
      readShared,
      writeShared,
      appAlive,
      appRunning,
      readStatus,
      runningApp,
      installedBundle,
    };
  });

export type FilesArea = Effect.Success<ReturnType<typeof makeFiles>>;
