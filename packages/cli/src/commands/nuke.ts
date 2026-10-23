// sm nuke: everything of this build off the machine, Settings' Danger
// zone with no window. The app in this command's bundle runs "Nuke
// everything" itself (--sm-nuke, the Danger zone's two halves and the
// start that deletes the files), as only it can revoke the device and
// turn its login item off. Then what a start can't take, as something
// of the app's is still running through it: the app's own folder, its
// logs and preferences, the data-folder lock, the config folder once
// empty, and the bundle (--keep-app keeps it). A kept app whose start
// couldn't delete a file keeps its own folder too, the nuke's marker in
// it, for its next start to finish.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { footprint, NUKE_EXIT, NUKE_SWITCH } from "@shigomori/engine/footprint";
import { flavorNames } from "@shigomori/engine/flavor";
import { childEnv } from "@shigomori/engine/processes";
import * as Paths from "@shigomori/engine/Paths";
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

// The bundle this command runs from, <bundle>/Contents/Resources/<name>.
const bundleOf = (executable: string): string | null => {
  const resources = dirname(realpathSync(executable));
  const contents = dirname(resources);
  const bundle = dirname(contents);
  return basename(resources) === "Resources" &&
    basename(contents) === "Contents" &&
    bundle.endsWith(".app")
    ? bundle
    : null;
};

// The processes running the app's executable.
const runningFrom = (executable: string): number[] =>
  execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row.replace(/^\d+\s+/, "").startsWith(executable))
    .map((row) => Number.parseInt(row, 10));

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
      const bundle = bundleOf(process.execPath);
      if (bundle === null) {
        return yield* new UsageError({
          problem: `nuke runs from a packaged build's ${paths.binaryName}. A dev build's is in Settings, under Danger zone.`,
        });
      }
      const executable = join(bundle, "Contents", "MacOS", names.appName);

      // Its window's own nuke would ask: this one quits it.
      const open = runningFrom(executable);
      for (const pid of open) process.kill(pid, "SIGTERM");
      if (
        open.length > 0 &&
        !(yield* until(
          () => runningFrom(executable).length === 0,
          QUIT_WITHIN_MS,
        ))
      ) {
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
        const code = spawnSync(executable, [`--${NUKE_SWITCH}`], {
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
      // Its helpers go a moment after it.
      yield* until(() => runningFrom(executable).length === 0, GONE_WITHIN_MS);

      const place = footprint(paths.flavor, {
        home: paths.home,
        configHome: paths.configHome,
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
      if (!input.keepApp) {
        // The URL scheme it registered goes with it.
        spawnSync(
          "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
          ["-u", bundle],
          { stdio: "ignore" },
        );
        rmSync(bundle, { recursive: true, force: true });
      }
      yield* out(
        `nuked ${names.appName}${input.keepApp ? "" : `, ${bundle} with it`}`,
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
