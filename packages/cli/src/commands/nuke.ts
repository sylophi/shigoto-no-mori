// sm nuke: everything of this build off the machine, Settings' Danger
// zone with no window. The app this command came with runs "Nuke
// everything" itself (--sm-nuke, the Danger zone's halves and the start
// that deletes the files), as only it can revoke the device and turn
// its login item off: a Mac's bundle, or a Linux install's host, its
// unit taken out first. Then what a start can't take, as something of
// the app's is still running through it: the app's own folder (a Linux
// install's, the install with it), its logs and preferences, the
// data-folder lock, the config folder once empty, and a Mac's bundle
// (--keep-app keeps it). A kept app whose start couldn't delete a file
// keeps its own folder too, the nuke's marker in it, for its next start
// to finish.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { footprint, NUKE_EXIT, NUKE_SWITCH } from "@shigomori/engine/footprint";
import { type Flavor, flavorNames } from "@shigomori/engine/flavor";
import * as HostUnit from "@shigomori/engine/hostUnit";
import {
  HOST_BUNDLE,
  HOST_RUNTIME,
  installedVersionOf,
  linuxInstall,
} from "@shigomori/engine/linuxInstall";
import { childEnv } from "@shigomori/engine/processes";
import * as Paths from "@shigomori/engine/Paths";
import { byPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { ExitCode, UsageError } from "../errors.ts";
import { rest } from "../here.ts";
import { note, out } from "../output.ts";

const QUIT_WITHIN_MS = 30_000;
const GONE_WITHIN_MS = 60_000;

// Whether `done` came to hold within `ms` of awake time, looked at every
// quarter second.
const until = (done: () => boolean, ms: number) =>
  Effect.sync(done).pipe(
    Effect.repeat({
      until: (held) => held,
      schedule: Schedule.spaced("250 millis"),
    }),
    Effect.timeoutOption(ms),
    Effect.map(Option.getOrElse(done)),
  );

// The app this command came with, as the nuke drives it, or null for a
// dev build's command.
type NukedApp = {
  // What starts it to nuke.
  readonly start: readonly [string, ...string[]];
  // It quit, and whether it did.
  readonly quit: Effect.Effect<
    boolean,
    Effect.Error<Unit>,
    Effect.Services<Unit>
  >;
  // Its helpers gone, which go a moment after it.
  readonly gone: Effect.Effect<void>;
  // A Mac's bundle, deleted last but for --keep-app. A Linux install
  // is in the app's own folder, so it has none.
  readonly bundle: string | null;
};
type Unit = ReturnType<typeof HostUnit.uninstallUnit>;

// A Mac's bundle, <bundle>/Contents/Resources/<name>, its app quit as
// any other.
const macApp = (appName: string): NukedApp | null => {
  const resources = dirname(realpathSync(process.execPath));
  const contents = dirname(resources);
  const bundle = dirname(contents);
  if (
    basename(resources) !== "Resources" ||
    basename(contents) !== "Contents" ||
    !bundle.endsWith(".app")
  ) {
    return null;
  }
  const executable = join(bundle, "Contents", "MacOS", appName);
  // The processes running the app's executable.
  const runningFrom = (): number[] =>
    execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .map((row) => row.trim())
      .filter((row) => row.replace(/^\d+\s+/, "").startsWith(executable))
      .map((row) => Number.parseInt(row, 10));
  return {
    start: [executable],
    quit: Effect.suspend(() => {
      // Its window's own nuke would ask: this one quits it.
      const open = runningFrom();
      for (const pid of open) process.kill(pid, "SIGTERM");
      return open.length === 0
        ? Effect.succeed(true)
        : until(() => runningFrom().length === 0, QUIT_WITHIN_MS);
    }),
    gone: until(() => runningFrom().length === 0, GONE_WITHIN_MS).pipe(
      Effect.asVoid,
    ),
    bundle,
  };
};

// A Linux install's version, versions/<version>/<name>, its host
// stopped for good with its unit.
const linuxApp = (
  flavor: Flavor,
  paths: Paths.Paths["Service"],
): NukedApp | null => {
  const install = linuxInstall(flavor, paths);
  const real = realpathSync(process.execPath);
  if (installedVersionOf(install, real) === undefined) return null;
  const folder = dirname(real);
  return {
    start: [join(folder, HOST_RUNTIME), join(folder, HOST_BUNDLE)],
    quit: HostUnit.uninstallUnit(install).pipe(Effect.as(true)),
    gone: Effect.void,
    bundle: null,
  };
};

export const nuke = Command.make(
  "nuke",
  {
    rest,
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false)),
    keepApp: Flag.Boolean("keep-app").pipe(Flag.withDefault(false)),
  },
  (input) =>
    Effect.gen(function* () {
      const paths = yield* Paths.Paths;
      const names = flavorNames(paths.flavor);
      if (input.rest.length > 0) {
        return yield* new UsageError({ problem: "nuke takes no arguments." });
      }
      if (!input.yes) {
        return yield* new UsageError({
          problem: `nuke deletes ${names.appName}'s data, worktrees, settings and sign-in from this machine, removes this device from your account, and deletes the app. Pass --yes to go ahead.`,
        });
      }
      const nuked = byPlatform({
        darwin: () => macApp(names.appName),
        linux: () => linuxApp(paths.flavor, paths),
      })();
      if (nuked === null) {
        return yield* new UsageError({
          problem: `nuke runs from a packaged build's ${paths.binaryName}. A dev build's is in Settings, under Danger zone.`,
        });
      }
      if (input.keepApp && nuked.bundle === null) {
        return yield* new UsageError({
          problem:
            "--keep-app keeps a Mac's bundle. A Linux install is in the app's own folder, so it goes.",
        });
      }
      if (!(yield* nuked.quit)) {
        return yield* new UsageError({
          problem: `${names.appName} didn't quit. Quit it and run nuke again.`,
        });
      }

      let left = false;
      let marked = false;
      for (let start = 0; ; start += 1) {
        if (start === 3) {
          return yield* new UsageError({
            problem: `${names.appName} didn't finish its nuke.`,
          });
        }
        const [command, ...args] = nuked.start;
        const code = spawnSync(command, [...args, `--${NUKE_SWITCH}`], {
          stdio: "inherit",
          env: childEnv(process.env),
        }).status;
        if (code === NUKE_EXIT.finished) break;
        if (code === NUKE_EXIT.finishedWithLeft) {
          left = true;
          break;
        }
        if (code === NUKE_EXIT.marked) {
          left = true;
          marked = true;
          break;
        }
        if (code === NUKE_EXIT.againWithLeft) left = true;
        else if (code !== NUKE_EXIT.again) {
          return yield* new UsageError({
            problem:
              code === NUKE_EXIT.running
                ? `${names.appName} is running. Quit it and run nuke again.`
                : `${names.appName} couldn't nuke (exit ${code}). Its log says why.`,
          });
        }
      }
      yield* nuked.gone;

      const place = footprint(paths.flavor, {
        home: paths.home,
        configHome: paths.configHome,
        dataHome: paths.dataHome,
        stateHome: paths.stateHome,
        binHome: "",
      });
      for (const { id, path } of place.paths) {
        if (id === "config") {
          // Its pointer went with the app's nuke, and its lock just
          // before. Anything else in it is the owner's.
          yield* Effect.try(() => {
            if (readdirSync(path).length === 0) rmdirSync(path);
          }).pipe(Effect.ignore);
        } else if (
          (id === "userData" && !(marked && input.keepApp)) ||
          id === "logs" ||
          id === "dataDirLock" ||
          id === "preferences"
        ) {
          // What the app's start couldn't delete, this can't either: said
          // as the app says it.
          const failed = yield* Effect.try(() =>
            rmSync(path, { recursive: true, force: true }),
          ).pipe(
            Effect.as(null),
            Effect.catch((error) =>
              Effect.succeed(errorMessageOf(error.cause)),
            ),
          );
          if (failed !== null) {
            left = true;
            yield* out(`[nuke] left: ${path}: ${failed}`);
          }
        }
      }
      const { bundle } = nuked;
      if (bundle !== null && !input.keepApp) {
        // The URL scheme it registered goes with it.
        spawnSync(
          "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
          ["-u", bundle],
          { stdio: "ignore" },
        );
        rmSync(bundle, { recursive: true, force: true });
      }
      yield* out(
        `nuked ${names.appName}${bundle === null || input.keepApp ? "" : `, ${bundle} with it`}`,
      );
      if (left) {
        yield* note(
          marked && input.keepApp
            ? `Some of it stayed, as said above. Once it's deleted, ${names.appName}'s next start finishes the nuke.`
            : "Some of it stayed, as said above.",
        );
        return yield* new ExitCode({ code: 1 });
      }
    }),
);
