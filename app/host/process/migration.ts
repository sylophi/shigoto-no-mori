// The v3 migration as it goes, told to the shell, which serves it to
// its windows (main/ipc/modules/migration.ts). Watched from before the
// engine's store opens, so the import and every move are told.
import * as Migration from "@shigomori/engine/Migration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { onShell, shellCalls } from "./shell";

export const tellShell = Layer.effectDiscard(
  Effect.gen(function* () {
    const migration = yield* Migration.Migration;
    const watching = yield* Deferred.make<void>();
    yield* migration.changes.pipe(
      Stream.tap(() => Deferred.succeed(watching, undefined)),
      Stream.runForEach((progress) =>
        onShell(() => shellCalls().migration(progress)).pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(watching);
  }),
);
