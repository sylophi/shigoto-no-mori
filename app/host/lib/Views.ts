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
import type { PushKeys, PushProducerPayload } from "@shigomori/contracts/types";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import type { Table } from "@shigomori/engine/StoreChanges";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HostPushes from "./HostPushes";

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

// A read of a view that landed, and the last refresh asked before it
// started, which it answers.
type Landed = { readonly key: string; readonly answers: number };

type Heard = {
  readonly asked: Stream.Stream<void>;
  readonly landing: <A, E, R>(
    read: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
};

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
    // The read of `key` hearing its refreshes, from now on and for the
    // scope's length: the asks, for it to read again, and its reads,
    // each saying as it lands which asks it answered.
    readonly hear: (key: string) => Effect.Effect<Heard, never, Scope.Scope>;
    // A read of `key` now, done once one that started after the ask
    // has landed, changed or not. Done at once when nothing watches it.
    readonly refresh: (key: string) => Effect.Effect<void>;
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
  const asks = yield* PubSub.unbounded<string>();
  const landings = yield* PubSub.unbounded<Landed>();
  // How many refreshes each key was asked so far, and how many reads
  // hear its asks.
  const counted = yield* Ref.make(new Map<string, number>());
  const hearing = yield* Ref.make(new Map<string, number>());
  const countOf = (key: string) =>
    Effect.map(Ref.get(counted), (counts) => counts.get(key) ?? 0);
  const add = (key: string, by: number) =>
    Ref.update(hearing, (heard) =>
      new Map(heard).set(key, (heard.get(key) ?? 0) + by),
    );
  return ViewShares.of({
    join: (key, read) => Stream.unwrap(RcMap.get(reads, new Shared(key, read))),
    hear: Effect.fn("ViewShares.hear")(function* (key: string) {
      const heard = yield* PubSub.subscribe(asks);
      yield* Effect.acquireRelease(add(key, 1), () => add(key, -1));
      return {
        asked: Stream.fromSubscription(heard).pipe(
          Stream.filter((asked) => asked === key),
          Stream.as(undefined),
        ),
        landing: (read) =>
          Effect.flatMap(countOf(key), (answers) =>
            read.pipe(
              Effect.ensuring(PubSub.publish(landings, { key, answers })),
            ),
          ),
      } satisfies Heard;
    }),
    refresh: Effect.fn("ViewShares.refresh")(function* (key: string) {
      const heard = yield* Ref.get(hearing);
      if ((heard.get(key) ?? 0) === 0) return;
      const landed = yield* PubSub.subscribe(landings);
      const ask = (yield* countOf(key)) + 1;
      yield* Ref.update(counted, (counts) => new Map(counts).set(key, ask));
      yield* PubSub.publish(asks, key);
      yield* Stream.fromSubscription(landed).pipe(
        Stream.filter((read) => read.key === key && read.answers >= ask),
        Stream.take(1),
        Stream.runDrain,
      );
    }, Effect.scoped),
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
  read: () => Effect.Effect<A, unknown, R>,
  when: (signal: Signal) => boolean,
  options: { readonly every?: Duration.Input } = {},
): Stream.Stream<A, unknown, Services | R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const shares = yield* ViewShares;
      const context = yield* Effect.context<Services | R>();
      return shares.join(
        key,
        reading(read, when, shares.hear(key), options).pipe(
          Stream.provideContext(context),
        ),
      ) as Stream.Stream<A, unknown>;
    }),
  );

const reading = <A, R>(
  read: () => Effect.Effect<A, unknown, R>,
  when: (signal: Signal) => boolean,
  hear: Effect.Effect<Heard, never, Scope.Scope>,
  options: { readonly every?: Duration.Input },
): Stream.Stream<A, unknown, Services | R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first read, so nothing between is lost.
      const store = yield* (yield* StoreChanges.StoreChanges).subscribe;
      const pushes = yield* (yield* HostPushes.HostPushes).subscribe;
      const { asked, landing } = yield* hear;
      const signals = Stream.merge(
        Stream.merge(
          store.pipe(
            Stream.map((tables): Signal => ({ kind: "store", tables })),
          ),
          pushes.pipe(Stream.map((push): Signal => ({ kind: "push", push }))),
        ).pipe(Stream.filter(when)),
        asked,
      );
      const ticks =
        options.every === undefined
          ? Stream.empty
          : Stream.tick(options.every).pipe(Stream.drop(1));
      return Stream.succeed(undefined).pipe(
        Stream.concat(Stream.merge(signals, ticks)),
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => landing(Effect.suspend(read))),
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
export const pushed = <M extends ContractModule, K extends PushKeys<M>>(
  module: M,
  key: K,
  matches: (payload: PushProducerPayload<M, K>) => boolean = () => true,
) => {
  const channel = channelOf(callOf(module, key));
  return (signal: Signal): boolean =>
    signal.kind === "push" &&
    signal.push.channel === channel &&
    matches(signal.push.payload as PushProducerPayload<M, K>);
};

export const either =
  (...whens: readonly ((signal: Signal) => boolean)[]) =>
  (signal: Signal): boolean =>
    whens.some((when) => when(signal));

// A refresh of the view read under `key`: a read now, done once it
// landed.
export const refresh = (key: string) =>
  Effect.flatMap(ViewShares, (shares) => shares.refresh(key));
