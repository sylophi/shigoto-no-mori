// Every push the host makes (a contract's streaming Rpc with no
// payload), as one stream: the host's view streams re-read off it, and
// the device link and the loopback serve it.
import {
  callOf,
  channelOf,
  type ContractModule,
} from "@shigomori/contracts/contract";
import type {
  PushKeys,
  PushPayload,
  PushProducerPayload,
} from "@shigomori/contracts/types";
import { resolvePush } from "@shared/ipc/push";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export type Push = {
  // The push's Rpc tag, `<module>:<key>`.
  readonly channel: string;
  // Checked against the push's schema already.
  readonly payload: unknown;
  // The push's `remote` annotation: whether a peer may hear it.
  readonly remote: boolean;
};

type Publish<R> = <M extends ContractModule, K extends PushKeys<M>>(
  module: M,
  key: K,
  payload: PushProducerPayload<M, K>,
) => R;

export class HostPushes extends Context.Service<
  HostPushes,
  {
    // To every window and process on the loopback and, when annotated
    // `remote`, to the device link's peers. The payload is checked
    // against its schema here, so a producer bug surfaces at its source.
    readonly publish: Publish<Effect.Effect<void>>;
    // The same, for a callback outside any effect.
    readonly publishUnsafe: Publish<void>;
    // Every push from the moment this returns, for as long as the scope
    // is open: a view subscribes before it reads, so a push in between
    // isn't lost.
    readonly subscribe: Effect.Effect<Stream.Stream<Push>, never, Scope.Scope>;
    // One channel's payloads, from the moment the stream is run.
    readonly stream: (channel: string) => Stream.Stream<unknown>;
  }
>()("sm/host/HostPushes") {}

export const layer = Layer.effect(
  HostPushes,
  Effect.map(
    Effect.acquireRelease(PubSub.unbounded<Push>(), PubSub.shutdown),
    (pubsub) =>
      HostPushes.of({
        publish: Effect.fn("HostPushes.publish")(function* <
          M extends ContractModule,
          K extends PushKeys<M>,
        >(module: M, key: K, payload: PushProducerPayload<M, K>) {
          yield* PubSub.publish(pubsub, resolvePush(module, key, payload));
        }),
        publishUnsafe: (module, key, payload) =>
          void PubSub.publishUnsafe(pubsub, resolvePush(module, key, payload)),
        subscribe: PubSub.subscribe(pubsub).pipe(
          Effect.map(Stream.fromSubscription),
        ),
        stream: (channel) =>
          Stream.fromPubSub(pubsub).pipe(
            Stream.filter((push) => push.channel === channel),
            Stream.map((push) => push.payload),
          ),
      }),
  ),
);

export const push: Publish<Effect.Effect<void, never, HostPushes>> = (
  module,
  key,
  payload,
) =>
  Effect.flatMap(HostPushes, (pushes) => pushes.publish(module, key, payload));

// One push's payloads, from the moment this returns, for as long as the
// scope is open.
export const payloads = <M extends ContractModule, K extends PushKeys<M>>(
  module: M,
  key: K,
) => {
  const channel = channelOf(callOf(module, key));
  return Effect.map(
    Effect.flatMap(HostPushes, (pushes) => pushes.subscribe),
    (pushes) =>
      pushes.pipe(
        Stream.filter((each) => each.channel === channel),
        // Decoded with this push's schema as it was published.
        Stream.map((each) => each.payload as PushPayload<M, K>),
      ),
  );
};
