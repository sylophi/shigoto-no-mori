// The updater's swap: the staged app put in place of the running one, and the old one kept until it starts.
import * as Effect from "effect/Effect";
import * as Darwin from "../Darwin.ts";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { UpdateInProgress } from "../stagingLock.ts";
import {
  APP_QUIT_TIMEOUT,
  NothingStaged,
  SignatureRejected,
  SwapFailed,
  isNewer,
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
    const stagedDir = files.at.staged;
    const { removeAll, run } = files;
    const { signerOf, verify } = signatures;
    const { lock, readManifest, clearStaged, bundleVersion } = staging;
    // --- the swap ---

    // Replaces `target` with `staged`, in an order that leaves every crash
    // point recoverable:
    //  1. Move (or, across volumes, copy) the staged bundle next to the
    //     target. The only slow step, and the target is untouched if it
    //     fails.
    //  2. Verify the signature again where it now sits, closing the gap
    //     since staging.
    //  3. Exchange the two in one step where the darwin helper can
    //     (renamex_np's RENAME_SWAP), so the target always holds an app;
    //     else rename the target aside and the new bundle in, two renames
    //     in one directory, each atomic, the first rolled back when the
    //     second fails, the aside holding the app between them.
    // The running terminal binary may live inside the target. Every step is
    // a rename or an unlink, never a write in place, so it keeps running.
    // The darwin helper, where the process has it (the terminal does,
    // beside its binary; the app's own updater graph never swaps).
    const darwin = yield* Effect.serviceOption(Darwin.Darwin);
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
      // And never older than the app it replaces, which another install
      // may have moved past the staged release meanwhile.
      yield* verify(
        { bundle: target, signer: signerOf(target) },
        incoming,
      ).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const version = yield* bundleVersion(incoming);
            if (!isNewer(version, yield* bundleVersion(target))) {
              return yield* new SignatureRejected({
                reason: "not-newer",
                bundle: incoming,
                version,
              });
            }
          }),
        ),
        Effect.tapError(() => removeAll(incoming)),
      );
      const aside = path.join(dir, `${base}.old-${pid}`);
      yield* removeAll(aside);
      // One exchange where the volume can make it: the new bundle and the
      // installed one trade places in one step, so no moment, a crash's
      // included, leaves no app at the target, and the old one goes after.
      if (Option.isSome(darwin)) {
        const version = yield* bundleVersion(incoming).pipe(Effect.option);
        const exchanged = yield* darwin.value
          .exchange({ a: incoming, b: target })
          .pipe(
            Effect.map((line) => !Darwin.isFailed(line)),
            Effect.orElseSucceed(() => false),
          );
        // A helper that failed after its call still made the exchange
        // when the target holds the new version now.
        const landed =
          exchanged ||
          (Option.isSome(version) &&
            Option.contains(
              yield* bundleVersion(target).pipe(Effect.option),
              version.value,
            ));
        if (landed) return yield* removeAll(incoming);
      }
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
