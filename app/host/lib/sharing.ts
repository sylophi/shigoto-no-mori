// This device's sharing switch (packages/contracts/src/modules/sharing.ts),
// kept in the store's device settings as shareWithDevices, and here as
// the value the device link's SharingGate reads on every call. A change
// from anywhere (the account page, `sm config` in a terminal) reaches it
// within a store tick, and goes out as sharing:changed: to this
// device's windows, and over the link to every peer.
import * as EngineConfig from "@shigomori/engine/Config";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class Sharing extends Context.Service<
  Sharing,
  {
    readonly current: Effect.Effect<boolean>;
    // The switch, then each time it moves.
    readonly changes: Stream.Stream<boolean>;
    readonly set: (on: boolean) => Effect.Effect<void>;
  }
>()("sm/host/Sharing") {}

const make = (options: {
  // Pushes sharing:changed.
  readonly announce: (on: boolean) => void;
}) =>
  Effect.gen(function* () {
    const config = yield* EngineConfig.Config;
    const written = yield* (yield* StoreChanges.StoreChanges).subscribe;
    const read = config
      .read({ kind: "device" })
      .pipe(Effect.map((doc) => doc?.["shareWithDevices"] !== false));
    const ref = yield* SubscriptionRef.make(yield* read);
    // A write and a re-read each settle under it, so a read that began
    // before a write never lands after it.
    const lock = yield* Semaphore.make(1);

    const settle = (on: boolean) =>
      Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(ref)) === on) return;
        yield* SubscriptionRef.set(ref, on);
        options.announce(on);
      });

    yield* written.pipe(
      Stream.filter((tables) => tables.has("device_config")),
      Stream.runForEach(() =>
        lock.withPermits(1)(Effect.flatMap(read, settle)),
      ),
      Effect.forkScoped,
    );

    const set = Effect.fn("Sharing.set")(function* (on: boolean) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* config
            .change({ kind: "device" }, (doc) => {
              const { shareWithDevices: _, ...rest } = doc;
              return on ? rest : { ...rest, shareWithDevices: false };
            })
            .pipe(Effect.orDie);
          yield* settle(on);
        }),
      );
    });

    return Sharing.of({
      current: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      set,
    });
  });

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(Sharing, make(options));
