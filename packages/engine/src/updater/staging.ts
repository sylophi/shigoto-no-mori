// The updater's staging: a release downloaded, unpacked and checked as the installation does it, and staged under the lock.
import type { StagedManifest } from "@shigomori/contracts/schemas/runtime";
import { StagedManifestSchema } from "@shigomori/contracts/schemas/runtime";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  acquireStagingLock,
  StagingLockUnavailable,
  UpdateInProgress,
} from "../stagingLock.ts";
import {
  deadlineIn,
  DOWNLOAD_TIMEOUT,
  DownloadFailed,
  type Running,
  StagingFailed,
  type UpdateInput,
  discard,
  feedRequest,
  isNewer,
  report,
  within,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { FeedsArea } from "./feeds.ts";
import type { Installation } from "./installation.ts";

export const makeStaging = ({
  files,
  feeds,
  installation,
}: {
  readonly files: FilesArea;
  readonly feeds: FeedsArea;
  readonly installation: Installation;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const {
      updates: updatesDir,
      staged: stagedDir,
      manifest: manifestPath,
      stagingLock: lockPath,
      download: downloadPath,
      extract: extractDir,
    } = files.at;
    const { removeAll, prune, makeDirectory, readShared, writeShared } = files;
    const { send, queryFeed } = feeds;
    // The stager's pidfile for the rest of the run. A failure other than
    // the lock's own reads as its folder's.
    const lock = acquireStagingLock(lockPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
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

    // The staged update a build at `version` can install: one newer than
    // it. An older or the same one is what an install by hand or a crash
    // between the swap and its cleanup left, which the swap would refuse.
    const installable = Effect.fn("Updater.staged")(function* (
      version: string,
    ) {
      return Option.filter(yield* readManifest, (staged) =>
        isNewer(staged.version, version),
      );
    });

    const clearStaged = removeAll(stagedDir);

    // What a crashed or superseded run leaves behind.
    const pruneLeftovers = Effect.fn("Updater.pruneLeftovers")(function* (
      installed: string,
    ) {
      yield* prune(downloadPath);
      yield* prune(extractDir);
      yield* installation.pruneLeftovers(installed);
    });

    const download = Effect.fn("Updater.download")(function* (
      url: string,
      running: Running,
    ) {
      const deadline = yield* deadlineIn(DOWNLOAD_TIMEOUT);
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
      yield* written.pipe(Effect.tapError(() => prune(downloadPath)));
    });

    // Checks the feed and, when a release is newer than this build, leaves
    // a verified copy in updates/staged. None when already up to date.
    // Everything runs under the lock, so a concurrent stager never sees
    // another's half-written files or deletes them.
    const stageUpdate = Effect.fn("Updater.stageUpdate")(function* (
      installed: string,
      input: UpdateInput,
    ) {
      const { running } = input;
      yield* lock;
      yield* pruneLeftovers(installed);
      const { release, confirmed } = yield* queryFeed(input);
      if (release === undefined) {
        // A fresh boot after an install can find its own (or an older)
        // version still staged, which would offer a pointless downgrade
        // forever. Only a confirmed answer clears it: the kept release list
        // can lag a release an earlier run staged, and that stays ready.
        if (confirmed) {
          // Required only while the update would still be offered: one
          // of this build's version or older is offered never again.
          const offered = yield* installable(running.version);
          yield* Option.isSome(offered)
            ? clearStaged
            : clearStaged.pipe(Effect.ignore);
          return Option.none<StagedManifest>();
        }
        return yield* installable(running.version);
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
      const candidate = yield* installation.unpack(installed, release, input);
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
      yield* prune(extractDir);
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

    return {
      lock,
      readManifest,
      installable,
      clearStaged,
      stageUpdate,
    };
  });

export type StagingArea = Effect.Success<ReturnType<typeof makeStaging>>;
