// A Windows install to the updater (installation.ts): Squirrel.Windows'
// folder per version (windowsInstall.ts), which Update.exe adds the new
// one to from a folder holding its package and the RELEASES file naming
// it. The trust is GitHub's, as on Linux: the package holds to the
// digest the release list names for it. A version runs from its own
// folder until it exits, and Squirrel's launchers start the newest, so
// the swap changes nothing that runs. Squirrel keeps the version it
// replaced and removes the ones before it.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { programFile } from "../executables.ts";
import { type Flavor, flavorNames } from "../flavor.ts";
import { type Relaunched, relaunchEnvVars } from "../relaunchEnv.ts";
import type { ReleaseInfo } from "../updateFeed.ts";
import {
  squirrelPackageFile,
  windowsInstallRoot,
  windowsUpdateExe,
} from "../windowsInstall.ts";
import {
  causeText,
  NotInBundle,
  StagingFailed,
  SwapFailed,
  type UpdateInput,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { Installation } from "./installation.ts";

// Squirrel clears its own, and the staging area is the staging's.
const pruneLeftovers = () => Effect.void;

export const makeSquirrel = ({
  flavor,
  files,
}: {
  readonly flavor: Flavor;
  readonly files: FilesArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { download: downloadPath, extract: extractDir } = files.at;
    const { removeAll, run, makeDirectory, checkDigest, hashOf } = files;

    // The install's folder, two above the binary's resources.
    const installed = Effect.fn("Updater.installedSquirrel")(function* (
      executable: string,
    ) {
      const resources = path.dirname(executable);
      const found = yield* fs
        .exists(windowsUpdateExe(resources))
        .pipe(Effect.orElseSucceed(() => false));
      if (!found) return yield* new NotInBundle();
      return windowsInstallRoot(resources);
    });

    // The package, under the name Squirrel reads its version from, and
    // its RELEASES line: SHA1, name and size.
    const unpack = Effect.fn("Updater.unpackSquirrel")(function* (
      _installed: string,
      release: ReleaseInfo,
      input: UpdateInput,
    ) {
      yield* checkDigest(release, input);
      const candidate = path.join(extractDir, release.version);
      const name = squirrelPackageFile(flavor, release.version);
      const nupkg = path.join(candidate, name);
      yield* removeAll(extractDir);
      yield* makeDirectory(candidate);
      yield* Effect.gen(function* () {
        yield* fs.rename(downloadPath, nupkg);
        const sha1 = yield* hashOf(nupkg, "sha1");
        const { size } = yield* fs.stat(nupkg);
        yield* fs.writeFileString(
          path.join(candidate, "RELEASES"),
          `${sha1.toUpperCase()} ${name} ${size}`,
        );
      }).pipe(
        Effect.mapError(
          (cause) => new StagingFailed({ reason: "extract", cause }),
        ),
      );
      return candidate;
    });

    // Not interruptible: Update.exe stopped partway leaves a half-written
    // version folder, which the launchers start as the newest. Its own
    // output is a progress count, so a failure points at its log.
    const swap = Effect.fn("Updater.swapSquirrel")(function* (
      staged: string,
      root: string,
    ) {
      const updated = yield* Effect.uninterruptible(
        run(path.join(root, "Update.exe"), ["--update", staged]),
      );
      if (!updated.ok) {
        return yield* new SwapFailed({
          reason: "install",
          cause: new Error(
            `${causeText(updated.cause)}, see ${path.join(root, "Squirrel-Update.log")}`,
          ),
        });
      }
    });

    // The newest version, started by Update.exe through the shell, so it
    // inherits none of the handles this run got from the app it replaces
    // (a listening port among them). As the swap ends, the new version's
    // Squirrel copies itself over Update.exe, and a start that meets the
    // copy fails, so a failed start is tried again.
    const relaunch = (root: string, carried: Relaunched) =>
      run(
        path.join(root, "Update.exe"),
        ["--processStart", programFile(flavorNames(flavor).appName)],
        "all",
        relaunchEnvVars(carried),
      ).pipe(
        Effect.repeat({
          until: (ran) => ran.ok,
          times: 3,
          schedule: Schedule.spaced("500 millis"),
        }),
      );

    return {
      installed,
      pruneLeftovers,
      unpack,
      swap,
      relaunch,
    } satisfies Installation;
  });
