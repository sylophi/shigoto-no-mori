// The updater's methods: check, stage, update and the install's finish.
import type { UpdateRequest } from "@shigomori/contracts/schemas/runtime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type Flavor, flavorNames } from "../flavor.ts";
import * as Paths from "../Paths.ts";
import { pidAlive } from "../processes.ts";
import {
  APP_PUBLISH_TIMEOUT,
  APP_QUIT_TIMEOUT,
  AppStillRunning,
  HandoffFailed,
  InvalidAppPid,
  RelaunchFailed,
  type Running,
  type Staged,
  type UpdateAvailable,
  type UpdateInput,
  type Updated,
  UpdatesUnavailable,
  causeText,
  polling,
  report,
  upToDate,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { FeedsArea } from "./feeds.ts";
import type { SignaturesArea } from "./signatures.ts";
import type { StagingArea } from "./staging.ts";
import type { SwapArea } from "./swap.ts";
import type { RestartArea } from "./restart.ts";

export const makeMethods = ({
  flavor,
  files,
  feeds,
  signatures,
  staging,
  swap,
  restart,
}: {
  readonly flavor: Flavor;
  readonly files: FilesArea;
  readonly feeds: FeedsArea;
  readonly signatures: SignaturesArea;
  readonly staging: StagingArea;
  readonly swap: SwapArea;
  readonly restart: RestartArea;
}) =>
  Effect.gen(function* () {
    const paths = yield* Paths.Paths;
    // Which releases this build is offered, none for dev.
    const offered = flavorNames(flavor).updates;

    const requestPath = files.at.request;

    const { run, writeShared, appRunning, runningApp, installedBundle } = files;
    const { queryFeed } = feeds;
    const { anchorOf } = signatures;
    const { stageUpdate } = staging;
    const { installStaged } = swap;
    const { waitForRestart, appendInstallLog } = restart;
    // --- the methods ---

    // open hands the app launchd's environment, not ours, so a data dir
    // the environment chose (a test run's) is passed on, or the app
    // would come back on the default one.
    const relaunchArgs = (bundle: string) =>
      paths.dataDirSource === "env"
        ? ["--env", `SHIGOMORI_DATA_DIR=${paths.dataDir}`, bundle]
        : [bundle];

    const available =
      offered === null ? Effect.fail(new UpdatesUnavailable()) : Effect.void;

    const check = Effect.fn("Updater.check")(function* (input: UpdateInput) {
      yield* available;
      yield* report(input, { phase: "checking" });
      const { release } = yield* queryFeed(input);
      if (release === undefined) return upToDate(input.running);
      return {
        ok: true,
        status: "update-available",
        version: release.version,
        installed: input.running.version,
      } satisfies UpdateAvailable;
    });

    const stageFor = Effect.fn("Updater.stageFor")(function* (
      input: UpdateInput,
    ) {
      yield* available;
      const installed = yield* anchorOf(
        yield* installedBundle(input.running.executable),
      );
      yield* report(input, { phase: "checking" });
      return { installed, staged: yield* stageUpdate(installed, input) };
    });

    const stage = Effect.fn("Updater.stage")(function* (input: UpdateInput) {
      const { staged } = yield* stageFor(input);
      if (Option.isNone(staged)) return upToDate(input.running);
      const { version, notes, releaseDate } = staged.value;
      return {
        ok: true,
        status: "staged",
        version,
        installed: input.running.version,
        ...(notes === undefined ? {} : { notes }),
        ...(releaseDate === undefined ? {} : { releaseDate }),
      } satisfies Staged;
    });

    const update = Effect.fn("Updater.update")(function* (input: UpdateInput) {
      const { running } = input;
      const { installed: anchor, staged } = yield* stageFor(input);
      if (Option.isNone(staged)) return upToDate(running);
      let app = yield* runningApp;
      if (Option.isNone(app) && (yield* appRunning)) {
        // A live instance that hasn't published its state yet (a fresh
        // launch, updater.json still naming the last run's pid). Swapping
        // now would leave it running a deleted bundle.
        yield* report(input, { phase: "waiting-for-app" });
        app = yield* runningApp.pipe(
          Effect.repeat({
            until: Option.isSome,
            schedule: polling(APP_PUBLISH_TIMEOUT),
          }),
        );
        if (Option.isNone(app)) {
          return yield* new HandoffFailed({
            reason: "unpublished",
            binary: paths.binaryName,
          });
        }
      }
      if (Option.isNone(app)) {
        yield* report(input, {
          phase: "installing",
          version: staged.value.version,
        });
        const installed = yield* installStaged(anchor.bundle, running.pid);
        return {
          ok: true,
          status: "updated",
          from: running.version,
          to: installed.version,
        } satisfies Updated;
      }
      const requestedAt = yield* Clock.currentTimeMillis;
      const request: UpdateRequest = { action: "install", requestedAt };
      yield* writeShared(
        requestPath,
        `${JSON.stringify(request, null, 2)}\n`,
        running.pid,
      ).pipe(
        Effect.mapError(
          (cause) => new HandoffFailed({ reason: "request", cause }),
        ),
      );
      yield* report(input, {
        phase: "restarting",
        version: staged.value.version,
      });
      const restarted = yield* waitForRestart(app.value, requestedAt, input);
      return {
        ok: true,
        status: "updated",
        from: app.value.appVersion,
        to: restarted.appVersion,
      } satisfies Updated;
    });

    const finishInstall = Effect.fn("Updater.finishInstall")(function* (input: {
      readonly running: Running;
      readonly appPid: number;
    }) {
      yield* available;
      if (input.appPid <= 0) return yield* new InvalidAppPid();
      const bundle = yield* installedBundle(input.running.executable).pipe(
        Effect.tapError((error) =>
          appendInstallLog(`finish-install: ${causeText(error)}`),
        ),
      );
      yield* appendInstallLog(
        `finish-install: waiting for app pid ${input.appPid} to exit`,
      );
      const alive = yield* pidAlive(input.appPid).pipe(
        Effect.repeat({
          while: (live) => live,
          schedule: polling(APP_QUIT_TIMEOUT),
        }),
      );
      if (alive) {
        const error = new AppStillRunning({ pid: input.appPid });
        yield* appendInstallLog(
          `finish-install: ${causeText(error)} (aborting)`,
        );
        return yield* error;
      }
      const installed = yield* installStaged(bundle, input.running.pid).pipe(
        // The app quit to restart, so the current version comes back rather
        // than leaving it closed. A failed swap has restored it.
        Effect.tapError((error) =>
          appendInstallLog(
            `finish-install: ${causeText(error)} (relaunching the current app)`,
          ).pipe(Effect.andThen(run("open", relaunchArgs(bundle)))),
        ),
      );
      // By path, in front: the user asked for the restart. A bundle id could
      // still resolve to the aside bundle just deleted.
      const relaunched = yield* run("open", relaunchArgs(bundle));
      if (!relaunched.ok) {
        yield* appendInstallLog(
          `finish-install: installed ${installed.version} but relaunch failed: ${causeText(relaunched.cause)}`,
        );
        return yield* new RelaunchFailed({
          version: installed.version,
          cause: relaunched.cause,
        });
      }
      yield* appendInstallLog(
        `finish-install: installed ${installed.version} and relaunched`,
      );
    });

    return { check, stage, update, finishInstall };
  });

export type MethodsArea = Effect.Success<ReturnType<typeof makeMethods>>;
