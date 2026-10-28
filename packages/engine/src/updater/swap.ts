// The updater's swap: the staged update put in place of the installed app, as the installation swaps it, and the staging area cleared.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { UpdateInProgress } from "../stagingLock.ts";
import { APP_QUIT_TIMEOUT, NothingStaged, polling } from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { Installation } from "./installation.ts";
import type { StagingArea } from "./staging.ts";

export const makeSwap = ({
  files,
  staging,
  installation,
}: {
  readonly files: FilesArea;
  readonly staging: StagingArea;
  readonly installation: Installation;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const stagedDir = files.at.staged;
    const { lock, readManifest, clearStaged } = staging;

    // Installs the staged update over `installed` and clears the staging
    // area. Under the lock, since the swap's scratch names are what a
    // stager's prune sweeps. A stager holding it is waited out for a while:
    // the app's periodic check can be mid-run when a restart is asked for,
    // and it dies with the app a moment later. The manifest is read once
    // the lock is held, since that stager may have replaced the bundle.
    const installStaged = Effect.fn("Updater.installStaged")(function* (
      installed: string,
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
      yield* installation.swap(
        path.join(stagedDir, manifest.value.bundleName),
        installed,
        manifest.value.version,
        pid,
      );
      // The update is in: a staged copy left over is this version, which
      // nothing offers again, and the next stage clears it.
      yield* clearStaged.pipe(Effect.ignore);
      return manifest.value;
    }, Effect.scoped);

    return { installStaged };
  });

export type SwapArea = Effect.Success<ReturnType<typeof makeSwap>>;
