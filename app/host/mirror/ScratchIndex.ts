// One private 0700 directory for every scratch copy of a worktree's
// index (gitState.ts), minted on first use and removed as the host's
// graph closes. Directly under a shared /tmp the copies' names are
// guessable, so another account could read one or pre-plant it as a
// symlink for the copy to write through.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export class ScratchIndex extends Context.Service<
  ScratchIndex,
  {
    readonly dir: Effect.Effect<string, PlatformError>;
    // A new directory in place of the one the OS reaped: it does so on
    // its own schedule, and a long-running app can outlive the one it had.
    readonly remint: Effect.Effect<string, PlatformError>;
  }
>()("sm/host/ScratchIndex") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const current = yield* Ref.make(Option.none<string>());
  const minting = yield* Semaphore.make(1);
  // A failed mint is not kept, or one transient temp-dir error would
  // poison every recompute for the rest of the run.
  const mint = Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "sm-index-" }),
    (dir) => Effect.ignore(fs.remove(dir, { recursive: true, force: true })),
  ).pipe(
    Scope.provide(scope),
    Effect.tap((dir) => Ref.set(current, Option.some(dir))),
  );
  return ScratchIndex.of({
    dir: minting.withPermit(
      Effect.flatMap(
        Ref.get(current),
        Option.match({ onNone: () => mint, onSome: Effect.succeed }),
      ),
    ),
    remint: minting.withPermit(mint),
  });
});

export const layer = Layer.effect(ScratchIndex, make);
