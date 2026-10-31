// A Mac's install to the updater (installation.ts): the signed .app,
// held to the installed app's code signature at staging and again where
// it lands, and swapped in whole.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as NativeFs from "../NativeFs.ts";
import type { ReleaseInfo } from "../updateFeed.ts";
import {
  NotInBundle,
  type Running,
  SignatureRejected,
  StagingFailed,
  SwapFailed,
  type UpdateInput,
  asideName,
  bundleVersionArgs,
  incomingName,
  isAsideName,
  isIncomingName,
  isNewer,
  report,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";
import type { Installation } from "./installation.ts";
import type { SignaturesArea } from "./signatures.ts";

export const makeBundle = ({
  files,
  signatures,
}: {
  readonly files: FilesArea;
  readonly signatures: SignaturesArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { download: downloadPath, extract: extractDir } = files.at;
    const { removeAll, prune, run, makeDirectory } = files;
    const { signerOf, anchorOf, verify } = signatures;
    // The filesystem helper, where the process has it (the terminal does,
    // beside its binary, and the app's own updater graph never swaps).
    const nativeFs = yield* Effect.serviceOption(NativeFs.NativeFs);

    // The installed bundle: two folders above the terminal's binary, which
    // runs from <bundle>/Contents/Resources (the command on PATH links
    // there). Anything else refuses, so a stray copy never swaps
    // /Applications.
    const installed = Effect.fn("Updater.installedBundle")(function* (
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

    // An aside bundle (<target>.old-*) goes only while the target exists:
    // a crash between the swap's two renames leaves the aside as the only
    // copy of the app.
    const pruneLeftovers = Effect.fn("Updater.pruneBundleLeftovers")(function* (
      target: string,
    ) {
      if (Option.isNone(yield* fs.stat(target).pipe(Effect.option))) return;
      const dir = path.dirname(target);
      const base = path.basename(target);
      const names = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        if (isAsideName(base, name) || isIncomingName(base, name)) {
          yield* prune(path.join(dir, name));
        }
      }
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

    // A bundle's own version (its Info.plist's), "" when it has none.
    const bundleVersion = (bundle: string) =>
      Effect.map(
        run(
          "plutil",
          bundleVersionArgs(path.join(bundle, "Contents", "Info.plist")),
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

    const unpack = Effect.fn("Updater.unpackBundle")(function* (
      bundle: string,
      release: ReleaseInfo,
      input: UpdateInput,
    ) {
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
      yield* verify(yield* anchorOf(bundle), candidate).pipe(
        Effect.andThen(
          offeredBundle(candidate, release.version, input.running),
        ),
        Effect.tapError(() => prune(extractDir)),
      );
      return candidate;
    });

    // Replaces `target` with `staged`, in an order that leaves every crash
    // point recoverable:
    //  1. Move (or, across volumes, copy) the staged bundle next to the
    //     target. The only slow step, and the target is untouched if it
    //     fails.
    //  2. Verify the signature again where it now sits, closing the gap
    //     since staging.
    //  3. Exchange the two in one step where the filesystem helper can,
    //     so the target always holds an app. Else rename the target aside
    //     and the new bundle in, two renames in one directory, each
    //     atomic, the first rolled back when the second fails, the aside
    //     holding the app between them.
    // The running terminal binary may live inside the target. Every step is
    // a rename or an unlink, never a write in place, so it keeps running.
    const swap = Effect.fn("Updater.swap")(function* (
      staged: string,
      target: string,
      _version: string,
      pid: number,
    ) {
      const dir = path.dirname(target);
      const base = path.basename(target);
      const incoming = path.join(dir, incomingName(base, pid));
      yield* removeAll(incoming);
      const moved = yield* fs.rename(staged, incoming).pipe(Effect.result);
      if (Result.isFailure(moved)) {
        // Another volume (SHIGOMORI_DATA_DIR can point anywhere): a copy
        // that keeps the metadata instead.
        const copied = yield* run("ditto", [staged, incoming]);
        if (!copied.ok) {
          yield* prune(incoming);
          return yield* new SwapFailed({
            reason: "move-next-to",
            cause: new Error(copied.output.trim()),
          });
        }
        yield* prune(staged);
      }
      // Verified against the installed app's Team ID read afresh, as the
      // app may have changed since staging, and never older than the app
      // it replaces, which another install may have moved past the
      // staged release meanwhile.
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
        Effect.tapError(() => prune(incoming)),
      );
      const aside = path.join(dir, asideName(base, pid));
      yield* removeAll(aside);
      // One exchange where the volume can make it: the new bundle and the
      // installed one trade places in one step, so no moment, a crash's
      // included, leaves no app at the target, and the old one goes after.
      if (Option.isSome(nativeFs)) {
        const version = yield* bundleVersion(incoming).pipe(Effect.option);
        const exchanged = yield* nativeFs.value
          .exchange({ a: incoming, b: target })
          .pipe(
            Effect.map((line) => !NativeFs.isFailed(line)),
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
        if (landed) return yield* prune(incoming);
      }
      // Not interruptible: an interruption between the two renames would
      // leave no app at the target.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const setAside = yield* fs.rename(target, aside).pipe(Effect.result);
          if (Result.isFailure(setAside)) {
            yield* prune(incoming);
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
            yield* prune(incoming);
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
      yield* prune(aside);
    });

    return {
      installed,
      pruneLeftovers,
      unpack,
      swap,
    } satisfies Installation;
  });
