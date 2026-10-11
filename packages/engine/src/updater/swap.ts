// The updater's swap: the staged app put in place of the running one, and the old one kept until it starts.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Paths from "../Paths.ts";
import { UpdateInProgress } from "../stagingLock.ts";
import {
  APP_QUIT_TIMEOUT,
  NothingStaged,
  SwapFailed,
  polling,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { SignaturesArea } from "./signatures.ts";
import type { StagingArea } from "./staging.ts";

export const makeSwap = ({
  files,
  signatures,
  staging,
}: {
  readonly files: FilesArea;
  readonly signatures: SignaturesArea;
  readonly staging: StagingArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const updatesDir = path.join(paths.dataDir, "updates");
    const stagedDir = path.join(updatesDir, "staged");
    const { removeAll, run } = files;
    const { signerOf, verify } = signatures;
    const { lock, readManifest, clearStaged } = staging;
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
      yield* verify(
        { bundle: target, signer: signerOf(target) },
        incoming,
      ).pipe(Effect.tapError(() => removeAll(incoming)));
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
            const restored = yield* fs
              .rename(aside, target)
              .pipe(Effect.result);
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

    return { installStaged };
  });

export type SwapArea = Effect.Success<ReturnType<typeof makeSwap>>;
