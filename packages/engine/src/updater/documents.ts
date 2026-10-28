// The updater's errors, documents and the pure helpers its areas share (EFFECT.md, section 2). `Updater.ts` re-exports what consumers use.
import type { UpdateStageResultSchema } from "@shigomori/contracts/schemas/runtime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Headers from "effect/http/Headers";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { elapsedMillis } from "../elapsed.ts";
import { errnoText } from "../platformErrors.ts";
import { parse, SemVer } from "semver";
import { StagingLockUnavailable, UpdateInProgress } from "../stagingLock.ts";
import { APP_REPO } from "../flavor.ts";
import { byPlatform } from "../platform.ts";
import { formatKitchen, RELEASE_LIST_URL } from "../updateFeed.ts";
import { errorMessageOf } from "@shigomori/contracts/errors";

// What failed underneath, with what failed under an HTTP request too.
export const causeText = (cause: unknown): string => {
  if (HttpClientError.isHttpClientError(cause)) {
    const under = Predicate.hasProperty(cause.reason, "cause")
      ? cause.reason.cause
      : undefined;
    return under === undefined
      ? cause.message
      : `${cause.message}: ${causeText(under)}`;
  }
  if (PlatformError.isPlatformError(cause)) return errnoText(cause);
  return errorMessageOf(cause);
};

// --- errors ------------------------------------------------------------------

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
      "other-app",
      "no-identifier",
      "not-newer",
      "other-version",
    ]),
    bundle: Schema.String,
    team: Schema.optional(Schema.String),
    installedTeam: Schema.optional(Schema.String),
    identifier: Schema.optional(Schema.String),
    installedIdentifier: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
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
      case "other-app":
        return `The downloaded update is a different app (${this.identifier}, installed app: ${this.installedIdentifier}). Refusing to install.`;
      case "no-identifier":
        return `codesign reported no Identifier for ${this.bundle}.`;
      case "not-newer":
        return `The update is version ${this.version}, which is not newer than the app it would replace. Refusing to install.`;
      case "other-version":
        return `The downloaded update is version ${this.version}, not the release it was offered as. Refusing to install.`;
    }
  }
}

// A removal a later step needs (a clear folder to stage or swap into)
// failed: `rm -rf` of `path`.
// A Linux release's tarball that isn't the one the release names.
export class DigestRejected extends Schema.TaggedError<DigestRejected>()(
  "DigestRejected",
  {
    reason: Schema.Literals(["missing", "other"]),
    version: Schema.String,
  },
) {
  override get message(): string {
    return this.reason === "missing"
      ? `The release ${this.version} names no digest for its download, so it can't be checked. Refusing to install.`
      : `The download of ${this.version} doesn't match the digest its release names. Refusing to install.`;
  }
}

export class RemoveFailed extends Schema.TaggedError<RemoveFailed>()(
  "RemoveFailed",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't remove ${this.path}: ${causeText(this.cause)}`;
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
      "withdraw",
      "not-taken",
      "declined",
      "nothing-staged",
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
      case "withdraw":
        return `Couldn't take the update request back: ${causeText(this.cause)}`;
      case "not-taken":
        return "The app didn't pick up the update request. Quit the app and run the update again.";
      case "declined":
        return "The restart was declined in the app, so the update wasn't installed. It stays staged for the next restart.";
      case "nothing-staged":
        return "The app found no update newer than itself to install.";
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

// Where a run has got to, for a spinner or the --json event stream.
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
  // empty or absent for the real ones. Either one turns both real
  // endpoints off, so one flag keeps a test build off them. An endpoint
  // without a stand-in then isn't asked.
  readonly feedUrl?: string | undefined;
  readonly releasesUrl?: string | undefined;
  readonly progress?: ((progress: Progress) => Effect.Effect<void>) | undefined;
};

// The updater's documents, field for field: the stage results the app
// reads (UpdateStageResultSchema), whose up-to-date `sm update --json`
// prints too, and the two only the terminal prints.
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

export type QueryError = BadUpdateUrl | FeedFailed | RateLimited;

type LockError = UpdateInProgress | StagingLockUnavailable | StagingFailed;

export type StageError =
  | NotInBundle
  | QueryError
  | LockError
  | DownloadFailed
  | SignatureRejected
  | DigestRejected
  | RemoveFailed;

export type InstallError =
  | LockError
  | NothingStaged
  | SwapFailed
  | SignatureRejected
  | RemoveFailed;

// --- the pipeline -------------------------------------------------------------

export const FEED_TIMEOUT = Duration.seconds(30);
// A generous budget for the zip (about 200MB on a slow connection). There
// is no byte progress, so this is what unsticks a blackholed connection.
export const DOWNLOAD_TIMEOUT = Duration.minutes(20);
export const FEED_BODY_LIMIT = 1 << 20;
export const RELEASE_LIST_BODY_LIMIT = 4 << 20;

// How long a fetched release list answers checks on its own. The app
// asks every 10 minutes and the terminal can ask in between, while an
// unauthenticated client gets 60 requests an hour per address, shared
// with every other tool on the network.
export const RELEASE_LIST_MAX_AGE = 15 * 60_000;

const POLL = Duration.millis(200);
// How long the installer waits for a quitting app to exit, and for a
// stager to let go of the lock.
export const APP_QUIT_TIMEOUT = Duration.minutes(2);
export const RESTART_TIMEOUT = Duration.minutes(2);
// How long a running app that hasn't published updater.json gets to do
// so. The swap never runs under a live instance.
export const APP_PUBLISH_TIMEOUT = Duration.seconds(20);
export const RESTART_HINT_AFTER = 15_000;
// How long a running app gets to take an install request (it looks every
// second) before the request is withdrawn.
export const CLAIM_WITHIN = 10_000;

// A wait of `limit` in polls, so it counts the time the machine is
// awake and running them: a sleep or a clock step spends none of it, as
// an elapsed limit on the wall clock (Schedule's `upTo` duration) would.
export const polling = (limit: Duration.Duration) =>
  Schedule.spaced(POLL).pipe(
    Schedule.upTo({
      times: Math.ceil(Duration.toMillis(limit) / Duration.toMillis(POLL)),
    }),
  );

export const report = (input: UpdateInput, progress: Progress) =>
  input.progress?.(progress) ?? Effect.void;

export const upToDate = (running: Running): UpToDate => ({
  ok: true,
  status: "up-to-date",
  version: running.version,
});

// What the swap leaves beside an app bundle named `base`, by the pid of
// the run that made it: the new bundle on its way in, hidden, and the
// installed one set aside, which a crash between the swap's two renames
// leaves as the only copy of the app.
export const incomingName = (base: string, pid: number) =>
  `.${base}.new-${pid}`;
export const asideName = (base: string, pid: number) => `${base}.old-${pid}`;
export const isIncomingName = (base: string, name: string) =>
  name.startsWith(`.${base}.new-`);
export const isAsideName = (base: string, name: string) =>
  name.startsWith(`${base}.old-`);

// The read of a bundle's version (CFBundleShortVersionString) from its
// Info.plist, the swap's and the doctor's alike.
export const bundleVersionArgs = (infoPlist: string) => [
  "-extract",
  "CFBundleShortVersionString",
  "raw",
  "-o",
  "-",
  infoPlist,
];

// Two unparseable versions are never newer.
export const isNewer = (version: string, than: string) => {
  const a = parse(version);
  const b = parse(than);
  return a !== null && b !== null && a.compare(b) > 0;
};

export const feedRequest = (url: string, running: Running) =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader(
      "User-Agent",
      `shigoto-no-mori-cli/${running.version}`,
    ),
  );

export const header = (
  response: HttpClientResponse.HttpClientResponse,
  name: string,
) => Option.getOrUndefined(Headers.get(response.headers, name));

// One budget through every phase of a request (headers, body, drain):
// a deadline in elapsed time (`../elapsed.ts`), which a sleep or a clock
// step between phases doesn't move.
export const deadlineIn = (budget: Duration.Duration) =>
  Effect.map(elapsedMillis, (now) => now + Duration.toMillis(budget));

// `effect` within what is left of the time until `deadline`.
export const within = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: number,
) =>
  Effect.flatMap(elapsedMillis, (now) =>
    Effect.timeout(effect, Duration.millis(Math.max(0, deadline - now))),
  );

export const isBadUrl = (error: HttpClientError.HttpClientError) =>
  Predicate.isTagged(error.reason, "InvalidUrlError");

// An answer that won't be read, let go of: a first chunk at most, then
// the stream is cancelled.
export const discard = (
  response: HttpClientResponse.HttpClientResponse,
  deadline: number,
) =>
  within(Stream.runDrain(Stream.take(response.stream, 1)), deadline).pipe(
    Effect.ignore,
  );

// A version that doesn't parse ranks the release list as the lowest.
export const ZERO_VERSION = new SemVer("0.0.0");

// The two endpoints, either a stand-in's, or "" for one with none while
// the other has one. The update server serves the Mac's zips alone.
export const updateServerUrl = (input: UpdateInput) =>
  input.feedUrl || input.releasesUrl
    ? (input.feedUrl ?? "")
    : byPlatform({
        darwin: `https://update.electronjs.org/${APP_REPO}/darwin-${input.running.arch}/${input.running.version}`,
        linux: "",
      });

export const releaseListUrl = (input: UpdateInput) =>
  input.feedUrl || input.releasesUrl
    ? (input.releasesUrl ?? "")
    : RELEASE_LIST_URL;

export const feedFailed =
  (source: FeedFailed["source"]) =>
  (
    reason: FeedFailed["reason"],
    fields: { readonly status?: number; readonly cause?: unknown } = {},
  ) =>
    new FeedFailed({ source, reason, ...fields });

// A body's text, cut off at `limit` bytes as Go's LimitReader cuts it:
// nothing past the limit is read.
export const bodyText = (
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

// What a bundle's signature names: its Team ID ("" for an ad hoc
// signature) and its identifier, which tells one flavor's app from
// another's under the same team.
type Signer = { readonly team: string; readonly identifier: string };

// The installed app, and its signer, read once for a stage.
export type Anchor = {
  readonly bundle: string;
  readonly signer: Effect.Effect<Signer, SignatureRejected>;
};

// What the release list copy holds, its times in epoch ms (0 for none).
export type Kept = {
  readonly url: string;
  readonly fetchedAt: number;
  readonly etag: string;
  readonly retryAt: number;
  readonly body: unknown;
};

// What a finished command said: whether it exited 0, and its output.
export type Ran = {
  readonly ok: boolean;
  readonly output: string;
  readonly cause: unknown;
};

// Where the updater's files live in a data dir, for its areas, the
// doctor and the app's shell alike.
export const updaterFiles = (
  path: Pick<Path.Path, "join">,
  dataDir: string,
) => {
  const updates = path.join(dataDir, "updates");
  const staged = path.join(updates, "staged");
  return {
    updates,
    staged,
    manifest: path.join(staged, "manifest.json"),
    stagingLock: path.join(updates, "staging.pid"),
    download: path.join(updates, "download.zip"),
    extract: path.join(updates, "extract"),
    releaseList: path.join(updates, "release-list.json"),
    installLog: path.join(updates, "install.log"),
    installFailure: path.join(updates, "install-failure.json"),
    // What the app publishes, and what the terminal asks of it.
    status: path.join(dataDir, "updater.json"),
    request: path.join(dataDir, "updater-request.json"),
  };
};
