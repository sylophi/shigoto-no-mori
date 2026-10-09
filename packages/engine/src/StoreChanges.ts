import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { watchedTables } from "./migrations/changes.ts";

export type Table = (typeof watchedTables)[number];

// Short enough to read as immediate. A tick with nothing written is one
// read of two counters.
const TICK = Duration.millis(500);

// What changed in the store, for a process that shows it: the host, so
// that what the terminal `sm` or the app itself writes reaches every
// view within a tick. The terminal doesn't watch.
export class StoreChanges extends Context.Service<
  StoreChanges,
  {
    // The tables written since the last tick, by any connection, for as
    // long as the scope is open. Subscribed by the time it returns, so a
    // view subscribes before it reads and misses nothing.
    readonly subscribe: Effect.Effect<
      Stream.Stream<ReadonlySet<Table>>,
      never,
      Scope.Scope
    >;
    // Stops watching, before the data-folder move renames the data dir
    // out from under the store, and folds the write-ahead log into the
    // store file, so a move that copies across volumes copies it whole.
    // The app relaunches right after.
    readonly release: Effect.Effect<void>;
  }
>()("sm/engine/StoreChanges") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pubsub = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlySet<Table>>(),
    PubSub.shutdown,
  );
  // Whether anything was written since the last look: the rows this
  // connection changed and the data version, which moves when another
  // connection commits.
  const written = sql<{
    readonly own: number;
    readonly other: number;
  }>`SELECT total_changes() AS own, data_version AS other FROM pragma_data_version`.pipe(
    Effect.map(([row]) => `${row?.own} ${row?.other}`),
  );
  const versions = sql<{
    readonly name: string;
    readonly version: number;
  }>`SELECT name, version FROM changes`.pipe(
    Effect.map((rows) => new Map(rows.map((row) => [row.name, row.version]))),
  );
  const seen = yield* Ref.make({
    written: yield* written,
    versions: yield* versions,
  });
  const look = Effect.gen(function* () {
    const last = yield* Ref.get(seen);
    const now = yield* written;
    if (now === last.written) return;
    const next = yield* versions;
    yield* Ref.set(seen, { written: now, versions: next });
    const changed = new Set(
      watchedTables.filter(
        (table) => next.get(table) !== last.versions.get(table),
      ),
    );
    if (changed.size > 0) yield* PubSub.publish(pubsub, changed);
  }).pipe(
    // A read that fails reads as no change, and the next tick looks
    // again.
    Effect.ignore,
  );
  const watching = yield* FiberHandle.make();
  yield* FiberHandle.run(
    watching,
    look.pipe(Effect.repeat(Schedule.spaced(TICK))),
  );
  return StoreChanges.of({
    subscribe: PubSub.subscribe(pubsub).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    release: FiberHandle.clear(watching).pipe(
      Effect.andThen(sql`PRAGMA wal_checkpoint(TRUNCATE)`),
      // A checkpoint a reader holds back leaves the log beside the
      // store, which the copy carries as well.
      Effect.ignore,
      Effect.withSpan("StoreChanges.release"),
    ),
  });
});

export const layer = Layer.effect(StoreChanges, make);
