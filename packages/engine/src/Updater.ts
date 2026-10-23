// The update pipeline behind `sm update`. It works on the same files
// under the data dir as the app and a v2 Go sm, so any of them picks up
// where another left off:
//   check  find the release to move to: read the repo's release list
//          and pick for itself (updateFeed.ts pickRelease). When GitHub
//          can't answer, ask the update.electronjs.org feed, which
//          compares versions itself (204 up to date, 200 the release's
//          zip) but hides prereleases.
//   stage  download the zip into updates/, extract it, verify its code
//          signature, and park the bundle in updates/staged with a
//          manifest the app reads too.
//   swap   replace the installed bundle with the staged one: placed next
//          to it first (the slow step, which may cross volumes), verified
//          again there, then two renames in one directory, the second
//          rolled back when it fails.
// The trust anchor is Apple's code signature: a bundle installs only when
// `codesign --verify` passes and its Team ID matches the installed app's,
// so a compromised feed can point at another release of ours and nowhere
// else. Every verification failure refuses the update.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type { StagedManifest } from "@shigomori/contracts/schemas/runtime";
import { type Flavor } from "./flavor.ts";
import { makeFiles } from "./updater/files.ts";
import { makeFeeds } from "./updater/feeds.ts";
import { makeSignatures } from "./updater/signatures.ts";
import { makeStaging } from "./updater/staging.ts";
import { makeSwap } from "./updater/swap.ts";
import { makeRestart } from "./updater/restart.ts";
import { makeMethods } from "./updater/methods.ts";
import {
  AppStillRunning,
  HandoffFailed,
  type InstallError,
  InvalidAppPid,
  NotInBundle,
  type QueryError,
  RelaunchFailed,
  type Running,
  type StageError,
  type Staged,
  type UpToDate,
  type UpdateAvailable,
  type UpdateInput,
  type Updated,
  UpdatesUnavailable,
} from "./updater/documents.ts";
export {
  AppStillRunning,
  HandoffFailed,
  InvalidAppPid,
  NotInBundle,
  RelaunchFailed,
  UpdatesUnavailable,
  causeText,
  updaterFiles,
} from "./updater/documents.ts";
export type {
  Progress,
  Running,
  Staged,
  UpToDate,
  UpdateAvailable,
  UpdateInput,
  Updated,
} from "./updater/documents.ts";

export class Updater extends Context.Service<
  Updater,
  {
    // --check: one feed request and no download. The only file it may
    // touch is the release list copy a prerelease build keeps.
    readonly check: (
      input: UpdateInput,
    ) => Effect.Effect<
      UpToDate | UpdateAvailable,
      UpdatesUnavailable | QueryError
    >;
    // Check, download and verify into updates/staged, short of
    // installing. The app's periodic check runs this, and `update` stages
    // the same way first, so the app and the terminal share one pipeline.
    readonly stage: (
      input: UpdateInput,
    ) => Effect.Effect<UpToDate | Staged, UpdatesUnavailable | StageError>;
    // The full update: stage, then install. With no app running the
    // bundle is swapped here and nothing is launched. A running app is
    // asked to restart into it instead (the request file), so its
    // confirmation shows where the user can see it.
    readonly update: (
      input: UpdateInput,
    ) => Effect.Effect<
      UpToDate | Updated,
      UpdatesUnavailable | StageError | InstallError | HandoffFailed
    >;
    // The staged update a build at `version` can restart into: newer
    // than it, its bundle there. The app offers it before any check.
    readonly staged: (
      version: string,
    ) => Effect.Effect<Option.Option<StagedManifest>>;
    // --finish-install: the detached installer the app spawns as it quits
    // to restart. Waits for the app's pid to exit, swaps the staged
    // bundle in and relaunches the app. Headless, so every outcome goes
    // to updates/install.log as well.
    readonly finishInstall: (input: {
      readonly running: Running;
      readonly appPid: number;
      // A test build's update stand-ins, which the relaunched app gets,
      // and its debugging port, so the lab drives the app it brings back.
      readonly feedUrl?: string;
      readonly releasesUrl?: string;
      readonly debugPort?: string;
    }) => Effect.Effect<
      void,
      | UpdatesUnavailable
      | InvalidAppPid
      | NotInBundle
      | AppStillRunning
      | InstallError
      | RelaunchFailed
    >;
  }
>()("sm/engine/Updater") {}

const make = Effect.fn("Updater.make")(function* (flavor: Flavor) {
  const files = yield* makeFiles({ flavor });
  const feeds = yield* makeFeeds({ flavor, files });
  const signatures = yield* makeSignatures({ files });
  const staging = yield* makeStaging({ files, feeds, signatures });
  const swap = yield* makeSwap({ files, signatures, staging });
  const restart = yield* makeRestart({ files });
  const methods = yield* makeMethods({
    files,
    feeds,
    signatures,
    staging,
    swap,
    restart,
  });
  const { check, stage, update, finishInstall } = methods;
  return Updater.of({
    check,
    stage,
    update,
    staged: staging.installable,
    finishInstall,
  });
});

export const layer = (flavor: Flavor) => Layer.effect(Updater, make(flavor));
