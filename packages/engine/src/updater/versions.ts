// A Linux install to the updater (installation.ts): a folder per
// version beside the installed one, `current` moved to the new one
// (linuxInstall.ts). The trust is GitHub's: the tarball holds to the
// digest the release list names for it, read from the API over HTTPS,
// the same the install script checks. A version runs from its own
// folder to its end, so the install changes nothing that runs, and the
// host's unit starts the new one when the host exits.
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { Flavor } from "../flavor.ts";
import {
  HOST_BUNDLE,
  installedVersionOf,
  linuxInstall,
  linuxPackageName,
} from "../linuxInstall.ts";
import * as Paths from "../Paths.ts";
import type { ReleaseInfo } from "../updateFeed.ts";
import {
  DigestRejected,
  NotInBundle,
  SignatureRejected,
  StagingFailed,
  SwapFailed,
  type UpdateInput,
  isNewer,
  report,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { Installation } from "./installation.ts";

// What an update leaves beside versions/ while it lands.
const INCOMING = ".incoming-";
const NEXT_CURRENT = ".current-";

export const makeVersions = ({
  flavor,
  files,
}: {
  readonly flavor: Flavor;
  readonly files: FilesArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const install = linuxInstall(flavor, yield* Paths.Paths);
    const { download: downloadPath, extract: extractDir } = files.at;
    const { removeAll, prune, run, makeDirectory } = files;

    // The version folder the binary runs from.
    const installed = Effect.fn("Updater.installedVersion")(function* (
      executable: string,
    ) {
      const resolved = yield* fs
        .realPath(executable)
        .pipe(Effect.orElseSucceed(() => executable));
      if (installedVersionOf(install, resolved) === undefined) {
        return yield* new NotInBundle();
      }
      return path.dirname(resolved);
    });

    const currentVersion = fs.readLink(install.current).pipe(
      Effect.map((target) => path.basename(target)),
      Effect.option,
    );

    // A landing a crash cut short, and every version but the one
    // `current` names and the running one, which runs on from its folder
    // until it exits.
    const pruneLeftovers = Effect.fn("Updater.pruneVersions")(function* (
      running: string,
    ) {
      const kept = new Set([path.basename(running)]);
      const current = yield* currentVersion;
      if (Option.isSome(current)) kept.add(current.value);
      const names = yield* fs
        .readDirectory(install.versions)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        if (!kept.has(name)) yield* prune(path.join(install.versions, name));
      }
      const root = path.dirname(install.current);
      for (const name of yield* fs
        .readDirectory(root)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
        if (name.startsWith(NEXT_CURRENT)) {
          yield* prune(path.join(root, name));
        }
      }
    });

    const digestOf = (file: string) =>
      Effect.gen(function* () {
        const hash = createHash("sha256");
        yield* Stream.runForEach(fs.stream(file), (chunk) =>
          Effect.sync(() => hash.update(chunk)),
        );
        return `sha256:${hash.digest("hex")}`;
      });

    // The tarball holds to its release's digest before anything is
    // unpacked, and holds the one folder of the version offered.
    const unpack = Effect.fn("Updater.unpackVersion")(function* (
      _running: string,
      release: ReleaseInfo,
      input: UpdateInput,
    ) {
      const { version } = release;
      yield* report(input, { phase: "verifying", version });
      if (!release.digest.startsWith("sha256:")) {
        yield* prune(downloadPath);
        return yield* new DigestRejected({ reason: "missing", version });
      }
      const digest = yield* digestOf(downloadPath).pipe(
        Effect.mapError(
          (cause) =>
            new StagingFailed({ reason: "read", path: downloadPath, cause }),
        ),
      );
      if (digest !== release.digest) {
        yield* prune(downloadPath);
        return yield* new DigestRejected({ reason: "other", version });
      }
      yield* removeAll(extractDir);
      yield* makeDirectory(extractDir);
      const extracted = yield* run("tar", [
        "-xzf",
        downloadPath,
        "-C",
        extractDir,
      ]);
      if (!extracted.ok) {
        yield* prune(extractDir);
        return yield* new StagingFailed({
          reason: "extract",
          cause: new Error(extracted.output.trim()),
        });
      }
      yield* fs.remove(downloadPath).pipe(Effect.ignore);
      const candidate = path.join(
        extractDir,
        linuxPackageName(flavor, version),
      );
      const host = path.join(candidate, HOST_BUNDLE);
      if (!(yield* fs.exists(host).pipe(Effect.orElseSucceed(() => false)))) {
        yield* prune(extractDir);
        return yield* new StagingFailed({
          reason: "read",
          path: host,
          cause: new Error("the update holds no host"),
        });
      }
      return candidate;
    });

    // The staged folder moved in as versions/<version> (copied, across
    // volumes, sharing its blocks where the filesystem can), then
    // `current` moved to it in one rename. Never to a version older than
    // the one `current` names, which another install may have moved past
    // the staged release meanwhile.
    const swap = Effect.fn("Updater.swapVersion")(function* (
      staged: string,
      _running: string,
      version: string,
      pid: number,
    ) {
      const current = yield* currentVersion;
      if (Option.isSome(current) && !isNewer(version, current.value)) {
        return yield* new SignatureRejected({
          reason: "not-newer",
          bundle: staged,
          version,
        });
      }
      const target = path.join(install.versions, version);
      const incoming = path.join(install.versions, `${INCOMING}${pid}`);
      yield* removeAll(incoming);
      const moved = yield* fs.rename(staged, incoming).pipe(Effect.result);
      if (Result.isFailure(moved)) {
        const copied = yield* run("cp", [
          "-a",
          "--reflink=auto",
          "--",
          staged,
          incoming,
        ]);
        if (!copied.ok) {
          yield* prune(incoming);
          return yield* new SwapFailed({
            reason: "move-next-to",
            cause: new Error(copied.output.trim()),
          });
        }
        yield* prune(staged);
      }
      yield* removeAll(target);
      const landed = yield* fs.rename(incoming, target).pipe(Effect.result);
      if (Result.isFailure(landed)) {
        yield* prune(incoming);
        return yield* new SwapFailed({
          reason: "move-next-to",
          cause: landed.failure,
        });
      }
      const next = path.join(
        path.dirname(install.current),
        `${NEXT_CURRENT}${pid}`,
      );
      const flipped = yield* fs
        .remove(next, { force: true })
        .pipe(
          Effect.andThen(
            fs.symlink(
              path.join(path.basename(install.versions), version),
              next,
            ),
          ),
          Effect.andThen(fs.rename(next, install.current)),
          Effect.result,
        );
      if (Result.isFailure(flipped)) {
        yield* prune(next);
        return yield* new SwapFailed({
          reason: "install",
          cause: flipped.failure,
        });
      }
    });

    return {
      installed,
      pruneLeftovers,
      unpack,
      swap,
    } satisfies Installation;
  });
