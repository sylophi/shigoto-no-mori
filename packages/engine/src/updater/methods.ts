// The updater's methods: check, stage, update and the install's finish.
import type { UpdateRequest } from "@shigomori/contracts/schemas/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
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
import type { Installation } from "./installation.ts";
import type { StagingArea } from "./staging.ts";
import type { SwapArea } from "./swap.ts";
import type { RestartArea } from "./restart.ts";
import { openEnvArgs, type Relaunched } from "../relaunchEnv.ts";

export const makeMethods = ({
  files,
  feeds,
  installation,
  staging,
  swap,
  restart,
}: {
  readonly files: FilesArea;
  readonly feeds: FeedsArea;
  readonly installation: Installation;
  readonly staging: StagingArea;
  readonly swap: SwapArea;
  readonly restart: RestartArea;
}) =>
  Effect.gen(function* () {
    const paths = yield* Paths.Paths;

    const requestPath = files.at.request;

    const { run, writeShared, appRunning, runningApp } = files;
    const { updates, queryFeed } = feeds;
    const { installed: installedOf } = installation;
    const { stageUpdate } = staging;
    const { installStaged } = swap;
    const { waitForRestart, appendInstallLog, noteInstallFailure } = restart;
    const relaunchArgs = (
      bundle: string,
      endpoints: Omit<Relaunched, "dataDir">,
    ) => [
      ...openEnvArgs({
        ...endpoints,
        dataDir: paths.dataDirSource === "env" ? paths.dataDir : undefined,
      }),
      bundle,
    ];

    const available = (endpoints: {
      readonly feedUrl?: string;
      readonly releasesUrl?: string;
    }) =>
      updates(endpoints) ? Effect.void : Effect.fail(new UpdatesUnavailable());

    const check = Effect.fn("Updater.check")(function* (input: UpdateInput) {
      yield* available(input);
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
      yield* available(input);
      const installed = yield* installedOf(input.running.executable);
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
      const { installed, staged } = yield* stageFor(input);
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
        const manifest = yield* installStaged(installed, running.pid);
        return {
          ok: true,
          status: "updated",
          from: running.version,
          to: manifest.version,
        } satisfies Updated;
      }
      const request: UpdateRequest = {
        action: "install",
        id: `${running.pid}-${(yield* Random.nextInt).toString(36)}`,
        appPid: app.value.pid,
        requesterPid: running.pid,
      };
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
      const restarted = yield* waitForRestart(app.value, request.id, input);
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
      readonly feedUrl?: string;
      readonly releasesUrl?: string;
      readonly debugPort?: string;
    }) {
      yield* available(input);
      if (input.appPid <= 0) return yield* new InvalidAppPid();
      const pid = input.running.pid;
      const failed = (error: unknown, after = "") =>
        noteInstallFailure(pid, `${causeText(error)}${after}`, {
          message: causeText(error),
        });
      const bundle = yield* installedOf(input.running.executable).pipe(
        Effect.tapError((error) => failed(error)),
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
        yield* failed(error, " (aborting)");
        return yield* error;
      }
      const installed = yield* installStaged(bundle, pid).pipe(
        // The app quit to restart, so the current version comes back rather
        // than leaving it closed. A failed swap has restored it.
        Effect.tapError((error) =>
          failed(error, " (relaunching the current app)").pipe(
            Effect.andThen(run("open", relaunchArgs(bundle, input))),
          ),
        ),
      );
      // By path, in front: the user asked for the restart. A bundle id could
      // still resolve to the aside bundle just deleted.
      const relaunched = yield* run("open", relaunchArgs(bundle, input));
      if (!relaunched.ok) {
        const error = new RelaunchFailed({
          version: installed.version,
          cause: relaunched.cause,
        });
        yield* failed(error);
        return yield* error;
      }
      yield* appendInstallLog(
        `finish-install: installed ${installed.version} and relaunched`,
      );
    });

    // The staged update put in place now, by the app it replaces, which
    // restarts into it on its own: a Linux host, which its unit starts
    // again once it exits.
    const install = Effect.fn("Updater.install")(function* (running: Running) {
      return yield* installStaged(
        yield* installedOf(running.executable),
        running.pid,
      );
    });

    return { check, stage, update, finishInstall, install };
  });
