// A Windows install to the updater (installation.ts): Velopack's
// (windowsInstall.ts), whose Update.exe puts a package's contents in
// place of current\. The trust is GitHub's, as on Linux: the package
// holds to the digest the release list names for it. Update.exe first
// stops every process running from the install, this one among them,
// so it is handed the package and left to swap once this process
// exits, and to start the app again when the swap asks for that. A
// failed swap keeps the version it replaced and starts that instead.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { type Flavor } from "../flavor.ts";
import { type Relaunched, relaunchEnvVars } from "../relaunchEnv.ts";
import type { ReleaseInfo } from "../updateFeed.ts";
import {
  windowsInstallRoot,
  windowsPackageId,
  windowsUpdateExe,
} from "../windowsInstall.ts";
import {
  NotInBundle,
  type Ran,
  StagingFailed,
  SwapFailed,
  type UpdateInput,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { Installation } from "./installation.ts";

const pruneLeftovers = () => Effect.void;

// Update.exe starts the app once it has swapped (swap).
const relaunch = () =>
  Effect.succeed<Ran>({ ok: true, output: "", cause: undefined });

export const makeVelopack = ({
  flavor,
  files,
}: {
  readonly flavor: Flavor;
  readonly files: FilesArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { download: downloadPath, extract: extractDir } = files.at;
    const { removeAll, makeDirectory, checkDigest } = files;

    // The install's folder, two above the binary's resources.
    const installed = Effect.fn("Updater.installedVelopack")(function* (
      executable: string,
    ) {
      const resources = path.dirname(executable);
      const found = yield* fs
        .exists(windowsUpdateExe(resources))
        .pipe(Effect.orElseSucceed(() => false));
      if (!found) return yield* new NotInBundle();
      return windowsInstallRoot(resources);
    });

    // The package, under the name Velopack reads its id and version from.
    const packageFile = (version: string) =>
      `${windowsPackageId(flavor)}-${version}-full.nupkg`;

    const unpack = Effect.fn("Updater.unpackVelopack")(function* (
      _installed: string,
      release: ReleaseInfo,
      input: UpdateInput,
    ) {
      yield* checkDigest(release, input);
      const candidate = path.join(extractDir, release.version);
      yield* removeAll(extractDir);
      yield* makeDirectory(candidate);
      yield* fs
        .rename(
          downloadPath,
          path.join(candidate, packageFile(release.version)),
        )
        .pipe(
          Effect.mapError(
            (cause) => new StagingFailed({ reason: "extract", cause }),
          ),
        );
      return candidate;
    });

    // The package goes to the install's packages folder, Velopack's
    // place for it, since the staged copy is cleared as this returns.
    const swap = Effect.fn("Updater.swapVelopack")(function* (
      staged: string,
      root: string,
      version: string,
      pid: number,
      carried?: Relaunched,
    ) {
      const packages = path.join(root, "packages");
      const nupkg = path.join(packages, packageFile(version));
      yield* Effect.gen(function* () {
        yield* removeAll(packages);
        yield* makeDirectory(packages);
        yield* fs.copyFile(path.join(staged, packageFile(version)), nupkg);
      }).pipe(
        Effect.mapError(
          (cause) => new SwapFailed({ reason: "move-next-to", cause }),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              path.join(root, "Update.exe"),
              [
                "apply",
                "--silent",
                "--waitPid",
                String(pid),
                "--package",
                nupkg,
                ...(carried === undefined ? ["--norestart"] : []),
              ],
              {
                detached: true,
                extendEnv: true,
                env: carried === undefined ? {} : relaunchEnvVars(carried),
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              },
            ),
          );
          yield* Effect.asVoid(handle.unref);
        }),
      ).pipe(
        Effect.mapError(
          (cause) => new SwapFailed({ reason: "install", cause }),
        ),
      );
    });

    return {
      installed,
      pruneLeftovers,
      unpack,
      swap,
      relaunch,
    } satisfies Installation;
  });
