// A view: what a query answers, then again each time it changes. The
// host serves each one as a contract's view (`view` in
// packages/contracts/src/contract.ts), next to the query it watches.
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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HostPushes from "./hostPushes";

// What every view reads its signals from.
export type Services = StoreChanges.StoreChanges | HostPushes.HostPushes;

// What may have moved a view: tables the store wrote (StoreChanges),
// or a push the host made (a git watcher's ping, a script starting).
export type Signal =
  | { readonly kind: "store"; readonly tables: ReadonlySet<Table> }
  | { readonly kind: "push"; readonly push: HostPushes.Push };

// Re-reads `read` on every signal `when` keeps, and on a tick when
// something outside the store and the host moves the view (a file
// edited in the worktree, a server coming up on a port). Emits only
// what differs from the last value. Signals that arrive during a read
// make one more read, not one each.
export const view = <A, R = never>(
  read: () => Effect.Effect<A, unknown, R> | A | Promise<A>,
  when: (signal: Signal) => boolean,
  options: { readonly every?: Duration.Input } = {},
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
