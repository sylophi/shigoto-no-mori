// The updater's staging: a release downloaded, extracted, checked and staged under the lock.
import type { StagedManifest } from "@shigomori/contracts/schemas/runtime";
import { StagedManifestSchema } from "@shigomori/contracts/schemas/runtime";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Paths from "../Paths.ts";
import {
  acquireStagingLock,
  StagingLockUnavailable,
  stagingLockPath,
  UpdateInProgress,
} from "../stagingLock.ts";
import {
  type Anchor,
  DOWNLOAD_TIMEOUT,
  DownloadFailed,
  type Running,
  SignatureRejected,
  StagingFailed,
  type UpdateInput,
  discard,
  feedRequest,
  isNewer,
  newerThan,
  report,
  within,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { FeedsArea } from "./feeds.ts";
import type { SignaturesArea } from "./signatures.ts";

export const makeStaging = ({
  files,
  feeds,
  signatures,
}: {
  readonly files: FilesArea;
  readonly feeds: FeedsArea;
  readonly signatures: SignaturesArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const updatesDir = path.join(paths.dataDir, "updates");
    const stagedDir = path.join(updatesDir, "staged");
    const manifestPath = path.join(stagedDir, "manifest.json");
    const lockPath = stagingLockPath(path, paths.dataDir);
    const downloadPath = path.join(updatesDir, "download.zip");
    const extractDir = path.join(updatesDir, "extract");
    const { removeAll, run, readShared, writeShared } = files;
    const { send, queryFeed } = feeds;
    const { verify } = signatures;
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
        if (
          name.startsWith(`${base}.old-`) ||
          name.startsWith(`.${base}.new-`)
        ) {
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

    // A bundle's own version (its Info.plist's), "" when it has none.
    const bundleVersion = (bundle: string) =>
      Effect.map(
        run(
          "plutil",
          [
            "-extract",
            "CFBundleShortVersionString",
            "raw",
            "-o",
            "-",
            path.join(bundle, "Contents", "Info.plist"),
          ],
          "stdout",
        ),
        (read) => (read.ok ? read.output.trim() : ""),
      );

    // The downloaded bundle is the release the feed offered and newer than
    // this build, so a feed that serves an older release of ours under a
    // newer name gets nothing.
    const offeredBundle = (bundle: string, release: string, running: Running) =>
      Effect.gen(function* () {
        const version = yield* bundleVersion(bundle);
        if (version !== release) {
          return yield* new SignatureRejected({
            reason: "other-version",
            bundle,
            version,
          });
        }
        if (!isNewer(version, running.version)) {
          return yield* new SignatureRejected({
            reason: "not-newer",
            bundle,
            version,
          });
        }
      });

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
      if (
        Option.isSome(existing) &&
        existing.value.version === release.version
      ) {
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
        Effect.andThen(offeredBundle(candidate, release.version, running)),
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

    return { lock, readManifest, clearStaged, bundleVersion, stageUpdate };
  });

export type StagingArea = Effect.Success<ReturnType<typeof makeStaging>>;
