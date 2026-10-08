// sm update: the app (and with it this command, which lives in its
// bundle) brought up to date from the terminal, over the engine's
// Updater. --check only asks, --stage downloads and verifies, and the
// app spawns --finish-install --pid as it quits to restart.
import * as Updater from "@shigomori/engine/Updater";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { version } from "../build.ts";
import { UsageError } from "../errors.ts";
import { emit, note, out, Output, styles } from "../output.ts";
import { spinner } from "../spinner.ts";

// The variables the stand-in flags replaced, refused so one still
// exported can't send a test build to the real feeds.
const REPLACED: ReadonlyArray<readonly [string, string]> = [
  ["SHIGOMORI_UPDATE_FEED_URL", "--feed-url"],
  ["SHIGOMORI_UPDATE_RELEASES_URL", "--releases-url"],
];

const running: Updater.Running = {
  version,
  arch: process.arch,
  executable: process.execPath,
  pid: process.pid,
};

// A phase as the spinner says it.
const said = (progress: Updater.Progress, dim: (text: string) => string) => {
  switch (progress.phase) {
    case "checking":
      return "checking for updates";
    case "downloading":
    case "verifying":
    case "installing":
      return `${progress.phase} ${progress.version}`;
    case "restarting":
      return `restarting Shigoto no Mori to install ${progress.version}`;
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
    rest: Argument.String("args").pipe(Argument.variadic()),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Only say whether there is an update"),
      Flag.withDefault(false),
    ),
    stage: Flag.Boolean("stage").pipe(
      Flag.withDescription(
        "Download and verify the update, short of installing",
      ),
      Flag.withDefault(false),
    ),
    finishInstall: Flag.Boolean("finish-install").pipe(
      Flag.withDescription("Install once the app has quit (the app's)"),
      Flag.withDefault(false),
    ),
    pid: Flag.String("pid").pipe(Flag.optional),
    feedUrl: Flag.String("feed-url").pipe(Flag.optional),
    releasesUrl: Flag.String("releases-url").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      for (const [name, flag] of REPLACED) {
        if ((process.env[name] ?? "") !== "") {
          return yield* new UsageError({
            problem: `${name} is no longer read. Pass ${flag} instead.`,
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
            progress.set(said(phase, styles(stderrColor).dim)),
            json &&
              (phase.phase === "downloading" || phase.phase === "verifying")
              ? emit({ event: phase.phase, version: phase.version })
              : Effect.void,
          ),
      };
      const result = flags.check
        ? yield* updater.check(input)
        : flags.stage
          ? yield* updater.stage(input)
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
        case "staged":
          yield* out(
            `${green("update staged: ")}${cyan(result.version)}${dim(` (installed ${result.installed})`)}`,
          );
          return yield* hint;
        case "updated":
          return yield* out(
            `updated ${cyan(result.from)}${dim(" -> ")}${bold(green(result.to))}`,
          );
      }
    }).pipe(Effect.scoped),
).pipe(Command.withDescription("Update the app, and this command with it"));
