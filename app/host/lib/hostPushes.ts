// Every push the host makes (a contract's streaming Rpc with no
// payload, what the wires call a broadcast), as one stream: the
// host's view streams re-read off it, and the device link serves it.
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

export class HostPushes extends Context.Service<
  HostPushes,
  {
    readonly publish: (push: Push) => Effect.Effect<void>;
    // Every push from the moment this returns, for as long as the scope
    // is open: a view subscribes before it reads, so a push in between
    // isn't lost.
    readonly subscribe: Effect.Effect<Stream.Stream<Push>, never, Scope.Scope>;
    // One channel's payloads, from the moment the stream is run.
    readonly stream: (channel: string) => Stream.Stream<unknown>;
  }
>()("sm/host/HostPushes") {}

const over = (pubsub: PubSub.PubSub<Push>) =>
  HostPushes.of({
    publish: (push) => PubSub.publish(pubsub, push).pipe(Effect.asVoid),
    subscribe: PubSub.subscribe(pubsub).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    stream: (channel) =>
      Stream.fromPubSub(pubsub).pipe(
        Stream.filter((push) => push.channel === channel),
        Stream.map((push) => push.payload),
      ),
  });

export const layer = Layer.effect(
  HostPushes,
  Effect.map(
    Effect.acquireRelease(PubSub.unbounded<Push>(), PubSub.shutdown),
    over,
  ),
);

// The pushes on a hub its owner publishes on from outside any effect
// (the host's root, whose broadcasts must not wait for the graph).
export const layerOn = (pubsub: PubSub.PubSub<Push>) =>
  Layer.succeed(HostPushes, over(pubsub));
