// Notices what a terminal `sm` (or any other process) commits to the
// store, so it shows in the app within a tick: an agent running
// `sm describe` or `sm projects add` in a terminal should see the
// change without waiting for window focus. SQLite's data version moves
// only when another connection commits, so the app's own writes never
// read as a change. A new checkout writes nothing to the store; the git
// watcher sees it in the repository's git directory.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as PromiseAdapter from "./util/promiseAdapter";

// Short enough to read as immediate, and a pragma read costs
// microseconds.
const TICK = Duration.millis(500);

export class StoreWatcher extends Context.Service<
  StoreWatcher,
  {
    // Stops watching, before the data-folder move renames the data dir
    // out from under the store. The app relaunches right after.
    readonly release: Effect.Effect<void>;
  }
>()("sm/host/StoreWatcher") {}

const make = (onChange: () => void) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const watching = yield* FiberHandle.make();
    let seen = 0;
    const version = sql<{
      readonly data_version: number;
    }>`PRAGMA data_version`.pipe(
      Effect.map((rows) => rows[0]?.data_version ?? 0),
      // A read that fails reads as no change.
      Effect.orElseSucceed(() => seen),
    );
    seen = yield* version;
    yield* FiberHandle.run(
      watching,
      version.pipe(
        Effect.flatMap((now) =>
          Effect.sync(() => {
            if (now === seen) return;
            seen = now;
            onChange();
          }),
        ),
        Effect.repeat(Schedule.spaced(TICK)),
      ),
    );
    return StoreWatcher.of({
      release: FiberHandle.clear(watching).pipe(
        Effect.withSpan("StoreWatcher.release"),
      ),
    });
  });

export const layer = (onChange: () => void) =>
  Layer.effect(StoreWatcher, make(onChange));

// For the data-folder move, which is not Effect yet.
const promiseAdapter = PromiseAdapter.make<StoreWatcher>("The store watcher");
export const adapter = promiseAdapter.layer;

// A watcher that is not up has nothing to release.
export function stopStoreWatcher(): Promise<void> {
  return promiseAdapter.runIfOpen(
    Effect.gen(function* () {
      yield* (yield* StoreWatcher).release;
    }),
  );
}
