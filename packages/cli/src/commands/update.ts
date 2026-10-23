// sm update: the app (and with it this command, which lives in its
// bundle) brought up to date from the terminal, over the engine's
// Updater. --check only asks, and the app spawns --finish-install --pid
// as it quits to restart.
import * as Updater from "@shigomori/engine/Updater";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/cli/Command";
import { rest } from "../here.ts";
import * as Flag from "effect/cli/Flag";
import { flavorNames } from "@shigomori/engine/flavor";
import { RELAUNCH_ENV } from "@shigomori/engine/relaunchEnv";
import { flavor, version } from "../build.ts";
import { UsageError } from "../errors.ts";
import { emit, note, out, Output, styles } from "../output.ts";
import { spinner } from "../spinner.ts";

// The app's update stand-ins, which this command takes as flags. Set in
// its environment they are refused, so one exported for the app doesn't
// leave a test build's `update` on the real feeds unawares.
const STAND_INS: ReadonlyArray<readonly [string, string]> = [
  [RELAUNCH_ENV.feedUrl, "--feed-url"],
  [RELAUNCH_ENV.releasesUrl, "--releases-url"],
];

const running: Updater.Running = {
  version,
  arch: process.arch,
  executable: process.execPath,
  pid: process.pid,
};

// A phase as the spinner says it, `appName` being the flavor's app.
const said = (
  progress: Updater.Progress,
  appName: string,
  dim: (text: string) => string,
) => {
  switch (progress.phase) {
    case "checking":
      return "checking for updates";
    case "downloading":
    case "verifying":
    case "installing":
      return `${progress.phase} ${progress.version}`;
    case "restarting":
      return `restarting ${appName} to install ${progress.version}`;
    case "waiting-for-app":
      return "waiting for the running app";
    case "waiting-for-restart":
      return `waiting for the app to restart ${dim("(confirm in the app if it's asking)")}`;
  }
};

const text = (flag: Option.Option<string>) =>
  Option.getOrElse(flag, () => "").trim();

export const update = Command.make(
  "update",
  {
    rest,
    check: Flag.Boolean("check").pipe(Flag.withDefault(false)),
    finishInstall: Flag.Boolean("finish-install").pipe(Flag.withDefault(false)),
    pid: Flag.String("pid").pipe(Flag.optional),
    feedUrl: Flag.String("feed-url").pipe(Flag.optional),
    releasesUrl: Flag.String("releases-url").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      for (const [name, flag] of STAND_INS) {
        if ((process.env[name] ?? "") !== "") {
          return yield* new UsageError({
            problem: `update doesn't read ${name}. Pass ${flag} instead.`,
          });
        }
      }
      if (flags.rest.length > 0) {
        return yield* new UsageError({
          problem: "update takes no arguments (flags: --check).",
        });
      }
      const updater = yield* Updater.Updater;
      if (flags.finishInstall) {
        const pid = text(flags.pid);
        return yield* updater.finishInstall({
          running,
          appPid: /^[+-]?\d+$/.test(pid) ? Number(pid) : 0,
          feedUrl: text(flags.feedUrl),
          releasesUrl: text(flags.releasesUrl),
          // Only a build that takes a debugger (a test flavor) passes its
          // port to the app it brings back.
          ...(flavorNames(flavor).debuggable
            ? { debugPort: process.env[RELAUNCH_ENV.debugPort] ?? "" }
            : {}),
        });
      }
      const { json, stdoutColor, stderrColor, binaryName } =
        yield* Effect.service(Output);
      const { cyan, dim, green, bold } = styles(stdoutColor);
      const progress = yield* spinner;
      const input: Updater.UpdateInput = {
        running,
        feedUrl: text(flags.feedUrl),
        releasesUrl: text(flags.releasesUrl),
        progress: (phase) =>
          Effect.andThen(
            progress.set(
              said(phase, flavorNames(flavor).appName, styles(stderrColor).dim),
            ),
            json &&
              (phase.phase === "downloading" || phase.phase === "verifying")
              ? emit({ event: phase.phase, version: phase.version })
              : Effect.void,
          ),
      };
      const result = flags.check
        ? yield* updater.check(input)
        : yield* updater.update(input);
      yield* progress.stop;
      if (json) return yield* emit(result);
      const hint = note(
        styles(stderrColor).dim(`Run \`${binaryName} update\` to install.`),
      );
      switch (result.status) {
        case "up-to-date":
          return yield* out(`already up to date ${dim(`(${result.version})`)}`);
        case "update-available":
          yield* out(
            `${green("update available: ")}${cyan(result.version)}${dim(` (installed ${result.installed})`)}`,
          );
          return yield* hint;
        case "updated":
          return yield* out(
            `updated ${cyan(result.from)}${dim(" -> ")}${bold(green(result.to))}`,
          );
      }
    }).pipe(Effect.scoped),
);
