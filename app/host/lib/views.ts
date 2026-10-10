// A view: what a query answers, then again each time it changes. The
// host serves each one as a contract's view (`view` in
// packages/contracts/src/contract.ts), next to the query it watches.
// Every subscriber to a view with the same input (the app's windows,
// a peer, the terminal) joins one read of it (ViewShares).
import {
  callOf,
  channelOf,
  type ContractModule,
} from "@shigomori/contracts/contract";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
} from "@shigomori/contracts/types";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import type { Table } from "@shigomori/engine/StoreChanges";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Stream from "effect/Stream";
import * as HostPushes from "./hostPushes";

// What every view reads its signals from, and shares its read through.
export type Services =
  | StoreChanges.StoreChanges
  | HostPushes.HostPushes
  | ViewShares;

// A view's read, named by its key: equal to another by the key alone,
// so a subscriber finds the read already running for it.
class Shared implements Equal.Equal {
  readonly key: string;
  readonly read: Stream.Stream<unknown, unknown>;
  constructor(key: string, read: Stream.Stream<unknown, unknown>) {
    this.key = key;
    this.read = read;
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Shared && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

// The views' reads, one per key, each running while anyone subscribes
// and ending with its last subscriber. A subscriber that joins late
// starts from the current value. A slow one skips to the latest, which
// is all a view promises.
export class ViewShares extends Context.Service<
  ViewShares,
  {
    readonly join: (
      key: string,
      read: Stream.Stream<unknown, unknown>,
    ) => Stream.Stream<unknown, unknown>;
  }
>()("sm/host/ViewShares") {}

const makeShares = Effect.gen(function* () {
  const reads = yield* RcMap.make({
    lookup: (shared: Shared) =>
      Stream.broadcast(shared.read, {
        capacity: 16,
        strategy: "sliding",
        replay: 1,
      }),
  });
  return ViewShares.of({
    join: (key, read) => Stream.unwrap(RcMap.get(reads, new Shared(key, read))),
  });
});

export const layer = Layer.effect(ViewShares, makeShares);

// What may have moved a view: tables the store wrote (StoreChanges),
// or a push the host made (a git watcher's ping, a script starting).
export type Signal =
  | { readonly kind: "store"; readonly tables: ReadonlySet<Table> }
  | { readonly kind: "push"; readonly push: HostPushes.Push };

// Re-reads `read` on every signal `when` keeps, and on a tick when
// something outside the store and the host moves the view (a file
// edited in the worktree, a server coming up on a port). Emits only
// what differs from the last value. Signals that arrive during a read
// make one more read, not one each. `key` names the view and its input
// (`worktrees:watch:<projectId>`): subscribers with the same key share
// the read.
export const view = <A, R = never>(
  key: string,
  read: () => Effect.Effect<A, unknown, R> | A | Promise<A>,
  when: (signal: Signal) => boolean,
  options: { readonly every?: Duration.Input } = {},
): Stream.Stream<A, unknown, Services | R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const shares = yield* ViewShares;
      const context = yield* Effect.context<Services | R>();
      return shares.join(
        key,
        reading(read, when, options).pipe(Stream.provideContext(context)),
      ) as Stream.Stream<A, unknown>;
    }),
  );

const reading = <A, R>(
  read: () => Effect.Effect<A, unknown, R> | A | Promise<A>,
  when: (signal: Signal) => boolean,
  options: { readonly every?: Duration.Input },
): Stream.Stream<A, unknown, Services | R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first read, so nothing between is lost.
      const store = yield* (yield* StoreChanges.StoreChanges).subscribe;
      const pushes = yield* (yield* HostPushes.HostPushes).subscribe;
      const signals = Stream.merge(
        store.pipe(Stream.map((tables): Signal => ({ kind: "store", tables }))),
        pushes.pipe(Stream.map((push): Signal => ({ kind: "push", push }))),
      ).pipe(Stream.filter(when));
      const ticks =
        options.every === undefined
          ? Stream.empty
          : Stream.tick(options.every).pipe(Stream.drop(1));
      return Stream.succeed(undefined).pipe(
        Stream.concat(Stream.merge(signals, ticks)),
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() =>
          Effect.suspend(() => {
            const answer = read();
            return Effect.isEffect(answer)
              ? (answer as Effect.Effect<A, unknown, R>)
              : Effect.tryPromise(async () => answer);
          }),
        ),
        Stream.changes,
      );
    }),
  );

// A signal from the store writing any of `tables`.
export const wrote =
  (...tables: readonly Table[]) =>
  (signal: Signal): boolean =>
    signal.kind === "store" && tables.some((table) => signal.tables.has(table));

// A signal from a module's push whose payload `matches`.
export const pushed = <M extends ContractModule, K extends BroadcastKeys<M>>(
  module: M,
  key: K,
  matches: (payload: BroadcastProducerPayload<M, K>) => boolean = () => true,
) => {
  const channel = channelOf(callOf(module, key));
  return (signal: Signal): boolean =>
    signal.kind === "push" &&
    signal.push.channel === channel &&
    matches(signal.push.payload as BroadcastProducerPayload<M, K>);
};

export const either =
  (...whens: readonly ((signal: Signal) => boolean)[]) =>
  (signal: Signal): boolean =>
    whens.some((when) => when(signal));
