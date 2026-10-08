// The update pipeline behind `sm update`. It works on the same files
// under the data dir as the Go sm and the app, so any of them picks up
// where another left off:
//   check  find the release to move to. A full release asks the
//          update.electronjs.org feed, which compares versions itself
//          (204 up to date, 200 the release's zip). That feed hides
//          prereleases, so a prerelease build reads the repo's release
//          list and picks for itself (updateFeed.ts pickRelease).
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
import type {
  StagedManifest,
  UpdateRequest,
  UpdateStageResultSchema,
} from "@shigomori/contracts/schemas/runtime";
import { StagedManifestSchema } from "@shigomori/contracts/schemas/runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { Flavor } from "./flavor.ts";
import { parseJson } from "./json.ts";
import * as Paths from "./Paths.ts";
import { errnoText } from "./platformErrors.ts";
import { capture, pidAlive } from "./processes.ts";
import { compareSemver, isPrerelease, parseSemver } from "./semver.ts";
import {
  acquireStagingLock,
  StagingLockUnavailable,
  stagingLockPath,
  UpdateInProgress,
} from "./stagingLock.ts";
import {
  type AppStatus,
  appStatusOf,
  FeedAnswer,
  formatKitchen,
  formatLocalRfc3339,
  isRateLimited,
  parseReleaseDate,
  parseRfc3339,
  pickRelease,
  rateLimitReset,
  ReleaseList,
  ReleaseListCache,
  type ReleaseInfo,
  trimV,
} from "./updateFeed.ts";

// What failed underneath, with what failed under an HTTP request too.
const causeText = (cause: unknown): string => {
  if (HttpClientError.isHttpClientError(cause)) {
    const under = Predicate.hasProperty(cause.reason, "cause")
      ? cause.reason.cause
      : undefined;
    return under === undefined
      ? cause.message
      : `${cause.message}: ${causeText(under)}`;
  }
  if (PlatformError.isPlatformError(cause)) return errnoText(cause);
  return cause instanceof Error ? cause.message : String(cause);
};

// --- errors ------------------------------------------------------------------

// The messages are the Go sm's, what failed underneath included where Go
// includes it.

export class UpdatesUnavailable extends Schema.TaggedError<UpdatesUnavailable>()(
  "UpdatesUnavailable",
  {},
) {
  override get message(): string {
    return "This is the dev CLI. Dev builds have no update channel. Pull the checkout instead.";
  }
}

export class NotInBundle extends Schema.TaggedError<NotInBundle>()(
  "NotInBundle",
  {},
) {
  override get message(): string {
    return "This binary isn't running from the installed app bundle, so there is nothing to update.";
  }
}

// A URL no request can be made to: a stand-in's, or one a feed named.
export class BadUpdateUrl extends Schema.TaggedError<BadUpdateUrl>()(
  "BadUpdateUrl",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    const url =
      HttpClientError.isHttpClientError(this.cause) &&
      Predicate.isTagged(this.cause.reason, "InvalidUrlError")
        ? this.cause.reason.request.url
        : "";
    return `Bad update URL ${JSON.stringify(url)}: ${causeText(this.cause)}`;
  }
}

// One of the two feeds failed: the update server, or the release list a
// prerelease build reads.
export class FeedFailed extends Schema.TaggedError<FeedFailed>()("FeedFailed", {
  source: Schema.Literals(["update-server", "release-list"]),
  reason: Schema.Literals([
    "unreachable",
    "status",
    "unreadable",
    "malformed",
    "incomplete",
  ]),
  status: Schema.optional(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const server = this.source === "update-server";
    const cause = causeText(this.cause);
    switch (this.reason) {
      case "unreachable":
        return server
          ? `Couldn't reach the update feed: ${cause}`
          : `Couldn't reach the release list: ${cause}`;
      case "status":
        return server
          ? `The update feed answered HTTP ${this.status}.`
          : `The release list answered HTTP ${this.status}.`;
      case "unreadable":
        return `Couldn't read the release list: ${cause}`;
      case "malformed":
        return server
          ? `The update feed answered malformed JSON: ${cause}`
          : `The release list is malformed JSON: ${cause}`;
      case "incomplete":
        return "The update feed answered without a release URL or name.";
    }
  }
}

// GitHub spent the hourly budget of unauthenticated requests, and there
// is no earlier list to answer from.
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAt: Schema.Finite },
) {
  override get message(): string {
    return `GitHub is rate-limiting update checks from this address until ${formatKitchen(this.retryAt)}.`;
  }
}

export class DownloadFailed extends Schema.TaggedError<DownloadFailed>()(
  "DownloadFailed",
  {
    reason: Schema.Literals([
      "unreachable",
      "status",
      "create",
      "interrupted",
      "finish",
    ]),
    status: Schema.optional(Schema.Int),
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const cause = causeText(this.cause);
    switch (this.reason) {
      case "unreachable":
        return `Couldn't download the update: ${cause}`;
      case "status":
        return `Downloading the update failed with HTTP ${this.status}.`;
      case "create":
        return `Couldn't write the update to ${this.path}: ${cause}`;
      case "interrupted":
        return `The update download was interrupted: ${cause}`;
      case "finish":
        return `Couldn't finish writing the update: ${cause}`;
    }
  }
}

// A step of staging that isn't the download or the signature.
export class StagingFailed extends Schema.TaggedError<StagingFailed>()(
  "StagingFailed",
  {
    reason: Schema.Literals([
      "directory",
      "extract",
      "read",
      "bundles",
      "stage",
      "manifest",
    ]),
    path: Schema.optional(Schema.String),
    count: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const cause = causeText(this.cause);
    switch (this.reason) {
      case "directory":
        return `Couldn't create ${this.path}: ${cause}`;
      case "extract":
        return `Couldn't extract the update: ${cause}`;
      case "read":
        return `Couldn't read ${this.path}: ${cause}`;
      case "bundles":
        return `The update zip contained ${this.count} app bundles instead of exactly one.`;
      case "stage":
        return `Couldn't stage the update: ${cause}`;
      case "manifest":
        return `Couldn't write the staging manifest: ${cause}`;
    }
  }
}

// The update's signature didn't hold up, so it won't be installed.
export class SignatureRejected extends Schema.TaggedError<SignatureRejected>()(
  "SignatureRejected",
  {
    reason: Schema.Literals([
      "invalid",
      "unreadable",
      "no-team-identifier",
      "installed-unsigned",
      "other-team",
    ]),
    bundle: Schema.String,
    team: Schema.optional(Schema.String),
    installedTeam: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const cause = causeText(this.cause);
    switch (this.reason) {
      case "invalid":
        return `The downloaded update failed code-signature verification: ${cause}`;
      case "unreadable":
        return `Couldn't read the code signature of ${this.bundle}: ${cause}`;
      case "no-team-identifier":
        return `codesign reported no TeamIdentifier for ${this.bundle}.`;
      case "installed-unsigned":
        return "The installed app has no Team ID to verify the update against. Refusing to install.";
      case "other-team":
        return `The downloaded update is signed by a different team (${this.team}, installed app: ${this.installedTeam}). Refusing to install.`;
    }
  }
}

export class NothingStaged extends Schema.TaggedError<NothingStaged>()(
  "NothingStaged",
  {},
) {
  override get message(): string {
    return "No staged update to install.";
  }
}

// The swap stopped. Only "rollback" leaves the target missing, and then
// the old app is at `aside`.
export class SwapFailed extends Schema.TaggedError<SwapFailed>()("SwapFailed", {
  reason: Schema.Literals([
    "move-next-to",
    "move-aside",
    "install",
    "rollback",
  ]),
  aside: Schema.optional(Schema.String),
  cause: Schema.Defect(),
  rollbackCause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const cause = causeText(this.cause);
    switch (this.reason) {
      case "move-next-to":
        return `Couldn't move the update next to the app: ${cause}`;
      case "move-aside":
        return `Couldn't move the old app aside: ${cause}`;
      case "install":
        return `Couldn't install the update: ${cause} (the old app was restored)`;
      case "rollback":
        return `Couldn't install the update (${cause}) and restoring the old app failed too (${causeText(this.rollbackCause)}). The old app is at ${this.aside}.`;
    }
  }
}

// --finish-install was given no pid to wait for.
export class InvalidAppPid extends Schema.TaggedError<InvalidAppPid>()(
  "InvalidAppPid",
  {},
) {
  // A usage error, exit 2.
  get usage(): boolean {
    return true;
  }

  override get message(): string {
    return "--finish-install requires --pid <app pid>.";
  }
}

export class AppStillRunning extends Schema.TaggedError<AppStillRunning>()(
  "AppStillRunning",
  { pid: Schema.Int },
) {
  override get message(): string {
    return `Process ${this.pid} is still running after 2m0s.`;
  }
}

export class RelaunchFailed extends Schema.TaggedError<RelaunchFailed>()(
  "RelaunchFailed",
  { version: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Installed ${this.version} but couldn't relaunch the app: ${causeText(this.cause)}`;
  }
}

// Handing the install to the running app didn't work out.
export class HandoffFailed extends Schema.TaggedError<HandoffFailed>()(
  "HandoffFailed",
  {
    reason: Schema.Literals([
      "unpublished",
      "request",
      "install",
      "same-version",
      "timeout",
    ]),
    // The terminal command's name, for "unpublished".
    binary: Schema.optional(Schema.String),
    // The app's own words for its failed install.
    detail: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
    log: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unpublished":
        return `The app is running but hasn't published its updater state. Wait for it to finish starting (or quit it) and rerun \`${this.binary} update\`.`;
      case "request":
        return `Couldn't write the update request: ${causeText(this.cause)}`;
      case "install":
        return `Install failed: ${this.detail}`;
      case "same-version":
        return `The app restarted but is still on ${this.version}, so the install may have failed. Check ${this.log}.`;
      case "timeout":
        return "The app hasn't restarted yet. It may still be waiting on a confirmation in the app (confirming there will still install the update), or the install failed. Check the app.";
    }
  }
}

// --- the documents and the inputs ---------------------------------------------

// The process asking: its build, its binary and its pid.
export type Running = {
  // The build's version, "dev" when it names none.
  readonly version: string;
  // Electron's spelling of the architecture, which names the release
  // zips: arm64, x64.
  readonly arch: string;
  // The running binary. The terminal's sits at
  // <bundle>/Contents/Resources/<name>, and the bundle is what updates.
  readonly executable: string;
  readonly pid: number;
};

// Where a run has got to, for a spinner or the --json event stream
// (UpdateStageEventSchema has the downloading and verifying events).
export type Progress =
  | { readonly phase: "checking" }
  | {
      readonly phase: "downloading" | "verifying" | "installing" | "restarting";
      readonly version: string;
    }
  | { readonly phase: "waiting-for-app" | "waiting-for-restart" };

export type UpdateInput = {
  readonly running: Running;
  // Stand-ins for the two endpoints (`--feed-url`, `--releases-url`),
  // empty or absent for the real ones. A feed stand-in takes the
  // single-answer path on every build, prerelease or not, so one flag
  // keeps a test build off the real feeds.
  readonly feedUrl?: string | undefined;
  readonly releasesUrl?: string | undefined;
  readonly progress?: ((progress: Progress) => Effect.Effect<void>) | undefined;
};

// The documents `sm update --json` prints, field for field: the stage
// results the app reads (UpdateStageResultSchema) and the two documents
// only the terminal prints.
type StageResult = typeof UpdateStageResultSchema.Type;

export type UpToDate = { readonly ok: true } & Extract<
  StageResult,
  { readonly status: "up-to-date" }
>;

export type Staged = { readonly ok: true } & Extract<
  StageResult,
  { readonly status: "staged" }
>;

export type UpdateAvailable = {
  readonly ok: true;
  readonly status: "update-available";
  readonly version: string;
  readonly installed: string;
};

export type Updated = {
  readonly ok: true;
  readonly status: "updated";
  readonly from: string;
  readonly to: string;
};

type QueryError = BadUpdateUrl | FeedFailed | RateLimited;

type LockError = UpdateInProgress | StagingLockUnavailable | StagingFailed;

type StageError =
  | NotInBundle
  | QueryError
  | LockError
  | DownloadFailed
  | SignatureRejected;

type InstallError = LockError | NothingStaged | SwapFailed | SignatureRejected;

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
    // --stage: check, download and verify into updates/staged, short of
    // installing. The app's periodic check runs this, so the app and the
    // terminal share one pipeline.
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
    // --finish-install: the detached installer the app spawns as it quits
    // to restart. Waits for the app's pid to exit, swaps the staged
    // bundle in and relaunches the app. Headless, so every outcome goes
    // to updates/install.log as well.
    readonly finishInstall: (input: {
      readonly running: Running;
      readonly appPid: number;
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

// --- the pipeline -------------------------------------------------------------

// The repo behind the feeds (shared/packaging/cliDist.mts UPDATE_FEED_REPO).
const FEED_REPO = "sylophi/shigoto-no-mori";

// CFBundleExecutable of the app, which survives bundle moves and renames,
// so it tells the app from a process that got a recycled pid.
const APP_EXECUTABLE = "Shigoto no Mori";

const FEED_TIMEOUT = Duration.seconds(30);
// A generous budget for the zip (about 200MB on a slow connection). There
// is no byte progress, so this is what unsticks a blackholed connection.
const DOWNLOAD_TIMEOUT = Duration.minutes(20);
const FEED_BODY_LIMIT = 1 << 20;
const RELEASE_LIST_BODY_LIMIT = 4 << 20;

// How long a fetched release list answers checks on its own. The app
// asks every 10 minutes and the terminal can ask in between, while an
// unauthenticated client gets 60 requests an hour per address, shared
// with every other tool on the network.
const RELEASE_LIST_MAX_AGE = 15 * 60_000;

const POLL = Duration.millis(200);
// How long the installer waits for a quitting app to exit, and for a
// stager to let go of the lock.
const APP_QUIT_TIMEOUT = Duration.minutes(2);
const RESTART_TIMEOUT = Duration.minutes(2);
// How long a running app that hasn't published updater.json gets to do
// so. The swap never runs under a live instance.
const APP_PUBLISH_TIMEOUT = Duration.seconds(20);
const RESTART_HINT_AFTER = 15_000;

const polling = (limit: Duration.Duration) =>
  Schedule.spaced(POLL).pipe(Schedule.upTo({ duration: limit }));

const report = (input: UpdateInput, progress: Progress) =>
  input.progress?.(progress) ?? Effect.void;

const upToDate = (running: Running): UpToDate => ({
  ok: true,
  status: "up-to-date",
  version: running.version,
});

const newerThan = (running: Running, version: string) => {
  const current = parseSemver(running.version);
  const candidate = parseSemver(version);
  return (
    current !== undefined &&
    candidate !== undefined &&
    compareSemver(candidate, current) > 0
  );
};

const feedRequest = (url: string, running: Running) =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader(
      "User-Agent",
      `shigoto-no-mori-cli/${running.version}`,
    ),
  );

const header = (
  response: HttpClientResponse.HttpClientResponse,
  name: string,
) => Option.getOrUndefined(Headers.get(response.headers, name));

// `effect` within what is left of the time until `deadline`.
const within = <A, E, R>(effect: Effect.Effect<A, E, R>, deadline: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.timeout(effect, Duration.millis(Math.max(0, deadline - now))),
  );

const isBadUrl = (error: HttpClientError.HttpClientError) =>
  Predicate.isTagged(error.reason, "InvalidUrlError");

// An answer that won't be read, let go of as Go closes every body: a
// first chunk at most, then the stream is cancelled.
const discard = (
  response: HttpClientResponse.HttpClientResponse,
  deadline: number,
) =>
  within(Stream.runDrain(Stream.take(response.stream, 1)), deadline).pipe(
    Effect.ignore,
  );

const feedFailed =
  (source: FeedFailed["source"]) =>
  (
    reason: FeedFailed["reason"],
    fields: { readonly status?: number; readonly cause?: unknown } = {},
  ) =>
    new FeedFailed({ source, reason, ...fields });

// A body's text, cut off at `limit` bytes as Go's LimitReader cuts it:
// nothing past the limit is read.
const bodyText = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) => {
  let read = 0;
  return response.stream.pipe(
    Stream.takeUntil((chunk) => (read += chunk.length) >= limit),
    Stream.runCollect,
    Effect.map((chunks) => {
      const bytes = new Uint8Array(Math.min(read, limit));
      let at = 0;
      for (const chunk of chunks) {
        const part = chunk.subarray(0, bytes.length - at);
        bytes.set(part, at);
        at += part.length;
      }
      return new TextDecoder().decode(bytes);
    }),
  );
};

// The installed app, and its Team ID, read once for a stage.
type Anchor = {
  readonly bundle: string;
  readonly team: Effect.Effect<string, SignatureRejected>;
};

// What the release list copy holds, its times in epoch ms (0 for none).
type Kept = {
  readonly url: string;
  readonly fetchedAt: number;
  readonly etag: string;
  readonly retryAt: number;
  readonly body: unknown;
};

// What a finished command said: whether it exited 0, and its output.
type Ran = {
  readonly ok: boolean;
  readonly output: string;
  readonly cause: unknown;
};

const make = Effect.fn("Updater.make")(function* (flavor: Flavor) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const paths = yield* Paths.Paths;
  const temporaries = yield* Ref.make(0);

  const updatesDir = path.join(paths.dataDir, "updates");
  const stagedDir = path.join(updatesDir, "staged");
  const manifestPath = path.join(stagedDir, "manifest.json");
  const releaseListPath = path.join(updatesDir, "release-list.json");
  const lockPath = stagingLockPath(path, paths.dataDir);
  const downloadPath = path.join(updatesDir, "download.zip");
  const extractDir = path.join(updatesDir, "extract");
  const installLog = path.join(updatesDir, "install.log");
  const statusPath = path.join(paths.dataDir, "updater.json");
  const requestPath = path.join(paths.dataDir, "updater-request.json");

  const removeAll = (target: string) =>
    fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);

  // A command run to the end, `from` its stdout or both its streams.
  // One that couldn't start reads as a failure with no output.
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    from: "stdout" | "all" = "all",
  ) =>
    capture(spawner, command, args, { from }).pipe(
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

  // A file the Go sm, the app and the engine share, read leniently: one
  // that is missing, unreadable or malformed reads as absent.
  const readShared = <A>(
    file: string,
    decode: (value: unknown) => Option.Option<A>,
  ) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => Option.flatMap(parseJson(text), decode)),
      Effect.orElseSucceed(() => Option.none<A>()),
    );

  // Written whole through a temporary file beside it, as the Go sm writes.
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
      Effect.map((ps) => ps.ok && ps.output.includes(APP_EXECUTABLE)),
    );

  // Any process with the app's executable name, even one that hasn't
  // published updater.json yet. -x matches exactly, so the "... Helper"
  // processes don't count.
  const appRunning = run("pgrep", ["-x", APP_EXECUTABLE]).pipe(
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

  // --- the feeds ---

  // A request's answer, or why there is none: `unreachable` for anything
  // but a URL no request can be made to. It carries the headers Go's sm sends
  // and no trace ids, since it leaves for GitHub.
  const send = <E>(
    request: HttpClientRequest.HttpClientRequest,
    deadline: number,
    unreachable: (cause: unknown) => E,
  ) =>
    within(
      http
        .execute(request)
        .pipe(
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        ),
      deadline,
    ).pipe(
      Effect.mapError((cause) =>
        HttpClientError.isHttpClientError(cause) && isBadUrl(cause)
          ? new BadUpdateUrl({ cause })
          : unreachable(cause),
      ),
    );

  // The update server compares versions and answers 204 when nothing is
  // newer. This build's version is in the URL, so any other answer but
  // 200 means a broken feed, not a missing update.
  const queryUpdateServer = Effect.fn("Updater.queryUpdateServer")(function* (
    input: UpdateInput,
  ) {
    const { running } = input;
    const url =
      input.feedUrl ||
      `https://update.electronjs.org/${FEED_REPO}/darwin-${running.arch}/${running.version}`;
    const failed = feedFailed("update-server");
    const deadline =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(FEED_TIMEOUT);
    const response = yield* send(feedRequest(url, running), deadline, (cause) =>
      failed("unreachable", { cause }),
    );
    if (response.status !== 200) yield* discard(response, deadline);
    if (response.status === 204) return undefined;
    if (response.status !== 200) {
      return yield* failed("status", { status: response.status });
    }
    const answer = yield* within(
      bodyText(response, FEED_BODY_LIMIT).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(FeedAnswer)),
        ),
      ),
      deadline,
    ).pipe(Effect.mapError((cause) => failed("malformed", { cause })));
    const zip = answer?.url ?? "";
    const version = trimV(answer?.name ?? "");
    if (zip === "" || version === "") return yield* failed("incomplete");
    return {
      url: zip,
      version,
      notes: answer?.notes ?? "",
      releaseDate: parseReleaseDate(answer?.pub_date ?? ""),
    } satisfies ReleaseInfo;
  });

  const releasesOf = (body: unknown) =>
    Schema.decodeUnknownEffect(ReleaseList)(body).pipe(
      Effect.map((releases) => releases ?? []),
      Effect.mapError((cause) =>
        feedFailed("release-list")("malformed", { cause }),
      ),
    );

  // The kept copy of the release list, when it came from `url`.
  const readReleaseListCache = (url: string) =>
    readShared(releaseListPath, (value): Option.Option<Kept> => {
      const cache = Schema.decodeUnknownOption(ReleaseListCache)(value);
      if (Option.isNone(cache) || cache.value.url !== url) return Option.none();
      const { fetchedAt, etag = "", retryAt, body } = cache.value;
      const fetched = parseRfc3339(fetchedAt);
      return body === undefined || fetched === undefined
        ? Option.none()
        : Option.some({
            url,
            fetchedAt: fetched,
            etag,
            retryAt: parseRfc3339(retryAt ?? "") ?? 0,
            body,
          });
    });

  // Best effort: a copy that can't be written only costs the next check
  // a full request.
  const keepReleaseList = (kept: Kept, pid: number) =>
    writeShared(
      releaseListPath,
      `${JSON.stringify(
        {
          url: kept.url,
          fetchedAt: new Date(kept.fetchedAt).toISOString(),
          ...(kept.etag === "" ? {} : { etag: kept.etag }),
          retryAt: new Date(kept.retryAt).toISOString(),
          body: kept.body,
        },
        null,
        2,
      )}\n`,
      pid,
    ).pipe(Effect.ignore);

  // The release list, and whether the API confirmed it this run rather
  // than the kept copy answering. Within RELEASE_LIST_MAX_AGE the copy
  // answers on its own. After that the request carries its ETag (a 304
  // is free of the rate limit). While the API says the hourly budget is
  // spent, the copy answers until the reset, stale by at most an hour,
  // rather than an error in Settings.
  const fetchReleaseList = Effect.fn("Updater.fetchReleaseList")(function* (
    input: UpdateInput,
  ) {
    const { running } = input;
    const url =
      input.releasesUrl ||
      `https://api.github.com/repos/${FEED_REPO}/releases?per_page=100`;
    const failed = feedFailed("release-list");
    const cached = Option.getOrUndefined(yield* readReleaseListCache(url));
    const now = yield* Clock.currentTimeMillis;
    if (
      cached !== undefined &&
      (now < cached.fetchedAt + RELEASE_LIST_MAX_AGE || now < cached.retryAt)
    ) {
      return { releases: yield* releasesOf(cached.body), confirmed: false };
    }
    const request = feedRequest(url, running).pipe(
      HttpClientRequest.setHeaders({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(cached !== undefined && cached.etag !== ""
          ? { "If-None-Match": cached.etag }
          : {}),
      }),
    );
    const deadline = now + Duration.toMillis(FEED_TIMEOUT);
    const response = yield* send(request, deadline, (cause) =>
      failed("unreachable", { cause }),
    );
    if (response.status !== 200) yield* discard(response, deadline);
    if (response.status === 304 && cached !== undefined) {
      yield* keepReleaseList(
        { ...cached, fetchedAt: now, retryAt: 0 },
        running.pid,
      );
      return { releases: yield* releasesOf(cached.body), confirmed: true };
    }
    if (
      isRateLimited(response.status, header(response, "x-ratelimit-remaining"))
    ) {
      const retryAt = rateLimitReset(
        {
          reset: header(response, "x-ratelimit-reset"),
          retryAfter: header(response, "retry-after"),
        },
        now,
      );
      if (cached === undefined) return yield* new RateLimited({ retryAt });
      yield* keepReleaseList({ ...cached, retryAt }, running.pid);
      return { releases: yield* releasesOf(cached.body), confirmed: false };
    }
    if (response.status !== 200) {
      return yield* failed("status", { status: response.status });
    }
    const text = yield* within(
      bodyText(response, RELEASE_LIST_BODY_LIMIT),
      deadline,
    ).pipe(Effect.mapError((cause) => failed("unreadable", { cause })));
    const body = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (cause) => failed("malformed", { cause }),
    });
    const releases = yield* releasesOf(body);
    yield* keepReleaseList(
      {
        url,
        fetchedAt: now,
        etag: header(response, "etag") ?? "",
        retryAt: 0,
        body,
      },
      running.pid,
    );
    return { releases, confirmed: true };
  });

  // The release to move to (undefined: nothing newer), and whether the
  // answer came from the network this run. An answer from the kept
  // release list is unconfirmed: it can lag a release an earlier run
  // already staged, so it never counts as "up to date" for anything
  // destructive. A prerelease build ranks the release list itself (the
  // release workflow stamps the tag into the build, so v2.0.0-beta.2
  // runs as "2.0.0-beta.2"). Every other build lets the server compare.
  const queryFeed = Effect.fn("Updater.queryFeed")(function* (
    input: UpdateInput,
  ) {
    const current = parseSemver(input.running.version);
    if (!input.feedUrl && current !== undefined && isPrerelease(current)) {
      const list = yield* fetchReleaseList(input);
      return {
        release: pickRelease(current, list.releases, input.running.arch),
        confirmed: list.confirmed,
      };
    }
    return { release: yield* queryUpdateServer(input), confirmed: true };
  });

  // --- signatures ---

  // The bundle's Team ID, "" for an ad hoc signature.
  const teamOf = Effect.fn("Updater.teamOf")(function* (bundle: string) {
    const shown = yield* run("codesign", ["-dvv", "--", bundle]);
    if (!shown.ok) {
      return yield* new SignatureRejected({
        reason: "unreadable",
        bundle,
        cause: new Error(shown.output.trim()),
      });
    }
    const match = /(?:^|\n)TeamIdentifier=([^\n]+)/.exec(shown.output);
    if (match === null) {
      return yield* new SignatureRejected({
        reason: "no-team-identifier",
        bundle,
      });
    }
    const team = (match[1] ?? "").trim();
    return team === "not set" ? "" : team;
  });

  // The installed bundle for a run, its Team ID read at most once.
  const anchorOf = (bundle: string) =>
    Effect.map(
      Effect.cached(teamOf(bundle)),
      (team): Anchor => ({ bundle, team }),
    );

  // A valid deep, strict signature and the installed app's Team ID. An
  // unsigned installed app refuses too: with no anchor there is nothing
  // to trust, and release builds are always signed. The checks run at
  // once, and fail in the order Go's sm made them.
  const verify = Effect.fn("Updater.verify")(function* (
    installed: Anchor,
    candidate: string,
  ) {
    const [checked, installedTeam, team] = yield* Effect.all(
      [
        run("codesign", ["--verify", "--deep", "--strict", "--", candidate]),
        Effect.result(installed.team),
        Effect.result(teamOf(candidate)),
      ],
      { concurrency: "unbounded" },
    );
    if (!checked.ok) {
      return yield* new SignatureRejected({
        reason: "invalid",
        bundle: candidate,
        cause: new Error(checked.output.trim()),
      });
    }
    if (Result.isFailure(installedTeam)) return yield* installedTeam.failure;
    if (Result.isFailure(team)) return yield* team.failure;
    if (installedTeam.success === "") {
      return yield* new SignatureRejected({
        reason: "installed-unsigned",
        bundle: installed.bundle,
      });
    }
    if (team.success !== installedTeam.success) {
      return yield* new SignatureRejected({
        reason: "other-team",
        bundle: candidate,
        team: team.success,
        installedTeam: installedTeam.success,
      });
    }
  });

  // --- staging ---

  // The stager's pidfile for the rest of the run, its folder's failure
  // in Go's words.
  const lock = acquireStagingLock(lockPath).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.mapError((error) =>
      error instanceof UpdateInProgress ||
      error instanceof StagingLockUnavailable
        ? error
        : new StagingFailed({
            reason: "directory",
            path: updatesDir,
            cause: error,
          }),
    ),
  );

  // The staged update, when its manifest and its bundle are both there.
  const readManifest = Effect.gen(function* () {
    const manifest = yield* readShared(
      manifestPath,
      Schema.decodeUnknownOption(StagedManifestSchema),
    );
    if (Option.isNone(manifest)) return Option.none<StagedManifest>();
    const bundle = yield* fs
      .stat(path.join(stagedDir, manifest.value.bundleName))
      .pipe(Effect.option);
    return Option.isSome(bundle) && bundle.value.type === "Directory"
      ? manifest
      : Option.none<StagedManifest>();
  });

  const clearStaged = removeAll(stagedDir);

  // What a crashed or superseded run leaves behind. An aside bundle
  // (<target>.old-*) goes only while the target exists: a crash between
  // the swap's two renames leaves the aside as the only copy of the app.
  const pruneLeftovers = Effect.fn("Updater.pruneLeftovers")(function* (
    target: string,
  ) {
    yield* removeAll(downloadPath);
    yield* removeAll(extractDir);
    if (Option.isNone(yield* fs.stat(target).pipe(Effect.option))) return;
    const dir = path.dirname(target);
    const base = path.basename(target);
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of names) {
      if (name.startsWith(`${base}.old-`) || name.startsWith(`.${base}.new-`)) {
        yield* removeAll(path.join(dir, name));
      }
    }
  });

  const download = Effect.fn("Updater.download")(function* (
    url: string,
    running: Running,
  ) {
    const deadline =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(DOWNLOAD_TIMEOUT);
    const response = yield* send(
      feedRequest(url, running),
      deadline,
      (cause) => new DownloadFailed({ reason: "unreachable", cause }),
    );
    if (response.status !== 200) {
      yield* discard(response, deadline);
      return yield* new DownloadFailed({
        reason: "status",
        status: response.status,
      });
    }
    // The file's close is its scope's, and a close that fails is a
    // defect there, so it is caught as the step it is. A failure of any
    // step leaves no partial zip behind.
    const written = Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(downloadPath, { flag: "w" }).pipe(
          Effect.mapError(
            (cause) =>
              new DownloadFailed({
                reason: "create",
                path: downloadPath,
                cause,
              }),
          ),
        );
        yield* within(
          Stream.runForEach(response.stream, (chunk) => file.writeAll(chunk)),
          deadline,
        ).pipe(
          Effect.mapError(
            (cause) => new DownloadFailed({ reason: "interrupted", cause }),
          ),
        );
        yield* file.sync.pipe(
          Effect.mapError(
            (cause) => new DownloadFailed({ reason: "finish", cause }),
          ),
        );
      }),
    ).pipe(
      Effect.catchDefect((cause) =>
        Effect.fail(new DownloadFailed({ reason: "finish", cause })),
      ),
    );
    yield* written.pipe(Effect.tapError(() => removeAll(downloadPath)));
  });

  // A directory entry that is a directory itself, not a link to one.
  const isRealDirectory = (target: string) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
        return false;
      }
      const info = yield* fs.stat(target).pipe(Effect.option);
      return Option.isSome(info) && info.value.type === "Directory";
    });

  // The release zip holds exactly the .app at its top (Electron Forge's
  // zip maker). It is found rather than named, so renaming the app
  // doesn't strand old installs.
  const extractedBundle = Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(extractDir)
      .pipe(
        Effect.mapError(
          (cause) =>
            new StagingFailed({ reason: "read", path: extractDir, cause }),
        ),
      );
    const bundles: string[] = [];
    for (const name of names.toSorted()) {
      const entry = path.join(extractDir, name);
      if (name.endsWith(".app") && (yield* isRealDirectory(entry))) {
        bundles.push(entry);
      }
    }
    const [bundle] = bundles;
    if (bundle === undefined || bundles.length !== 1) {
      return yield* new StagingFailed({
        reason: "bundles",
        count: bundles.length,
      });
    }
    return bundle;
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

  // Checks the feed and, when a release is newer than this build, leaves
  // a verified bundle in updates/staged. None when already up to date.
  // Everything runs under the lock, so a concurrent stager never sees
  // another's half-written files or deletes them.
  const stageUpdate = Effect.fn("Updater.stageUpdate")(function* (
    installed: Anchor,
    input: UpdateInput,
  ) {
    const { running } = input;
    yield* lock;
    yield* pruneLeftovers(installed.bundle);
    const { release, confirmed } = yield* queryFeed(input);
    if (release === undefined) {
      // A fresh boot after an install can find its own (or an older)
      // version still staged, which would offer a pointless downgrade
      // forever. Only a confirmed answer clears it: the kept release list
      // can lag a release an earlier run staged, and that stays ready.
      if (confirmed) {
        yield* clearStaged;
        return Option.none<StagedManifest>();
      }
      return Option.filter(yield* readManifest, (manifest) =>
        newerThan(running, manifest.version),
      );
    }
    const existing = yield* readManifest;
    if (Option.isSome(existing) && existing.value.version === release.version) {
      return existing;
    }

    // An earlier staged bundle stays installable until the newer one is
    // verified: a failed download never costs the update already there.
    yield* report(input, { phase: "downloading", version: release.version });
    yield* download(release.url, running);
    yield* removeAll(extractDir);
    yield* makeDirectory(extractDir);
    // ditto keeps the resource forks and extended attributes the signature
    // covers, which a plain unzip can quietly break.
    const extracted = yield* run("ditto", [
      "-x",
      "-k",
      downloadPath,
      extractDir,
    ]);
    if (!extracted.ok) {
      return yield* new StagingFailed({
        reason: "extract",
        cause: new Error(extracted.output.trim()),
      });
    }
    yield* fs.remove(downloadPath).pipe(Effect.ignore);
    const candidate = yield* extractedBundle;
    // As Squirrel.Mac does: no quarantine flag on what gets installed,
    // which would translocate the app or prompt on relaunch. The zip's
    // own metadata is out of our hands. Quarantine is an xattr, not part
    // of the signature, so this is best effort.
    yield* run("xattr", ["-dr", "com.apple.quarantine", candidate]);

    yield* report(input, { phase: "verifying", version: release.version });
    yield* verify(installed, candidate).pipe(
      Effect.tapError(() => removeAll(extractDir)),
    );
    yield* clearStaged;
    yield* makeDirectory(stagedDir);
    const name = path.basename(candidate);
    yield* fs
      .rename(candidate, path.join(stagedDir, name))
      .pipe(
        Effect.mapError(
          (cause) => new StagingFailed({ reason: "stage", cause }),
        ),
      );
    yield* removeAll(extractDir);
    // Empty fields left out, as Go's omitempty leaves them.
    const manifest: StagedManifest = {
      version: release.version,
      bundleName: name,
      ...(release.notes === "" ? {} : { notes: release.notes }),
      ...(release.releaseDate === ""
        ? {}
        : { releaseDate: release.releaseDate }),
    };
    yield* writeShared(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      running.pid,
    ).pipe(
      Effect.mapError(
        (cause) => new StagingFailed({ reason: "manifest", cause }),
      ),
    );
    return Option.some(manifest);
  }, Effect.scoped);

  // --- the swap ---

  // Replaces `target` with `staged`, in an order that leaves every crash
  // point recoverable:
  //  1. Move (or, across volumes, copy) the staged bundle next to the
  //     target. The only slow step, and the target is untouched if it
  //     fails.
  //  2. Verify the signature again where it now sits, closing the gap
  //     since staging.
  //  3. Rename the target aside and the new bundle in: two renames in one
  //     directory, each atomic, the first rolled back when the second
  //     fails. Between them the aside still holds the app.
  // The running terminal binary may live inside the target. Every step is
  // a rename or an unlink, never a write in place, so it keeps running.
  const swap = Effect.fn("Updater.swap")(function* (
    staged: string,
    target: string,
    pid: number,
  ) {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const incoming = path.join(dir, `.${base}.new-${pid}`);
    yield* removeAll(incoming);
    const moved = yield* fs.rename(staged, incoming).pipe(Effect.result);
    if (Result.isFailure(moved)) {
      // Another volume (SHIGOMORI_DATA_DIR can point anywhere): a copy
      // that keeps the metadata instead.
      const copied = yield* run("ditto", [staged, incoming]);
      if (!copied.ok) {
        yield* removeAll(incoming);
        return yield* new SwapFailed({
          reason: "move-next-to",
          cause: new Error(copied.output.trim()),
        });
      }
      yield* removeAll(staged);
    }
    // The installed app's Team ID read afresh, as the app may have changed
    // since staging.
    yield* verify({ bundle: target, team: teamOf(target) }, incoming).pipe(
      Effect.tapError(() => removeAll(incoming)),
    );
    const aside = path.join(dir, `${base}.old-${pid}`);
    yield* removeAll(aside);
    // Not interruptible: an interruption between the two renames would
    // leave no app at the target.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const setAside = yield* fs.rename(target, aside).pipe(Effect.result);
        if (Result.isFailure(setAside)) {
          yield* removeAll(incoming);
          return yield* new SwapFailed({
            reason: "move-aside",
            cause: setAside.failure,
          });
        }
        const renamedIn = yield* fs
          .rename(incoming, target)
          .pipe(Effect.result);
        if (Result.isFailure(renamedIn)) {
          const restored = yield* fs.rename(aside, target).pipe(Effect.result);
          yield* removeAll(incoming);
          return yield* Result.isFailure(restored)
            ? new SwapFailed({
                reason: "rollback",
                aside,
                cause: renamedIn.failure,
                rollbackCause: restored.failure,
              })
            : new SwapFailed({ reason: "install", cause: renamedIn.failure });
        }
      }),
    );
    yield* removeAll(aside);
  });

  // Installs the staged update over `target` and clears the staging
  // area. Under the lock, since the swap's scratch names are what a
  // stager's prune sweeps. A stager holding it is waited out for a while:
  // the app's periodic check can be mid-run when a restart is asked for,
  // and it dies with the app a moment later. The manifest is read once
  // the lock is held, since that stager may have replaced the bundle.
  const installStaged = Effect.fn("Updater.installStaged")(function* (
    target: string,
    pid: number,
  ) {
    yield* lock.pipe(
      Effect.retry({
        while: (error) => error instanceof UpdateInProgress,
        schedule: polling(APP_QUIT_TIMEOUT),
      }),
    );
    const manifest = yield* readManifest;
    if (Option.isNone(manifest)) return yield* new NothingStaged();
    yield* swap(path.join(stagedDir, manifest.value.bundleName), target, pid);
    yield* clearStaged;
    return manifest.value;
  }, Effect.scoped);

  // --- the running app ---

  // The handed-off install restarts the app. Success is updater.json
  // naming a new pid and a new version: a failed swap relaunching the old
  // bundle mustn't read as "updated X -> X". An error the old pid
  // publishes after the request (its installer didn't start) fails at
  // once. A busy app confirms in a dialog this can't see, and a decline
  // runs out the clock with the old pid alive.
  const waitForRestart = Effect.fn("Updater.waitForRestart")(function* (
    app: AppStatus,
    requestedAt: number,
    input: UpdateInput,
  ) {
    const start = yield* Clock.currentTimeMillis;
    let sameVersion = false;
    let hinted = false;
    const look = Effect.gen(function* () {
      const status = Option.getOrUndefined(yield* readStatus);
      if (
        status !== undefined &&
        status.pid !== app.pid &&
        (yield* appAlive(status.pid))
      ) {
        if (status.appVersion !== app.appVersion) return Option.some(status);
        sameVersion = true;
      }
      const state = status?.state;
      if (status?.pid === app.pid && state?.kind === "error") {
        // Only an error written since the request: the app never clears
        // one from an earlier failed check on this path.
        const info = yield* fs.stat(statusPath).pipe(Effect.option);
        const written = Option.flatMap(info, (stat) => stat.mtime);
        if (Option.isSome(written) && written.value.getTime() > requestedAt) {
          return yield* new HandoffFailed({
            reason: "install",
            detail: state.message,
          });
        }
      }
      if (
        !hinted &&
        (yield* Clock.currentTimeMillis) - start > RESTART_HINT_AFTER
      ) {
        hinted = true;
        yield* report(input, { phase: "waiting-for-restart" });
      }
      return Option.none<AppStatus>();
    });
    const restarted = yield* look.pipe(
      Effect.repeat({
        until: Option.isSome,
        schedule: polling(RESTART_TIMEOUT),
      }),
    );
    if (Option.isSome(restarted)) return restarted.value;
    // Tentative, since a late confirmation still installs after this has
    // given up: the staged update survives until it is used.
    return yield* sameVersion
      ? new HandoffFailed({
          reason: "same-version",
          version: app.appVersion,
          log: installLog,
        })
      : new HandoffFailed({ reason: "timeout" });
  });

  const appendInstallLog = (line: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(updatesDir, { recursive: true });
      const now = yield* Clock.currentTimeMillis;
      yield* fs.writeFileString(
        installLog,
        `${formatLocalRfc3339(now)} ${line}\n`,
        { flag: "a" },
      );
    }).pipe(Effect.ignore);

  // --- the methods ---

  const available =
    flavor === "prod" ? Effect.void : Effect.fail(new UpdatesUnavailable());

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
      yield* appendInstallLog(`finish-install: ${causeText(error)} (aborting)`);
      return yield* error;
    }
    const installed = yield* installStaged(bundle, input.running.pid).pipe(
      // The app quit to restart, so the current version comes back rather
      // than leaving it closed. A failed swap has restored it.
      Effect.tapError((error) =>
        appendInstallLog(
          `finish-install: ${causeText(error)} (relaunching the current app)`,
        ).pipe(Effect.andThen(run("open", [bundle]))),
      ),
    );
    // By path, in front: the user asked for the restart. A bundle id could
    // still resolve to the aside bundle just deleted.
    const relaunched = yield* run("open", [bundle]);
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

  return Updater.of({ check, stage, update, finishInstall });
});

export const layer = (flavor: Flavor) => Layer.effect(Updater, make(flavor));
