// The host's pushes as a stream (host/lib/hostPushes.ts), on a hub the
// root publishes on synchronously (host/process/wires.ts): a push
// reaches a subscriber in order with its remote flag, and one made
// before anyone subscribed goes nowhere.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import * as HostPushes from "../host/lib/hostPushes.ts";

it("a published push reaches a subscriber, in order, with its remote flag", async () => {
  const hub = Effect.runSync(PubSub.unbounded<HostPushes.Push>());
  const publish = (push: HostPushes.Push) => {
    PubSub.publishUnsafe(hub, push);
  };
  publish({ channel: "early:push", payload: 0, remote: true });
  const heard = await Effect.gen(function* () {
    const subscribed = yield* (yield* HostPushes.HostPushes).subscribe;
    publish({ channel: "a:one", payload: 1, remote: true });
    publish({ channel: "a:two", payload: 2, remote: false });
    return yield* subscribed.pipe(Stream.take(2), Stream.runCollect);
  }).pipe(
    Effect.scoped,
    Effect.provide(HostPushes.layerOn(hub)),
    Effect.runPromise,
  );
  assert.deepEqual(heard, [
    { channel: "a:one", payload: 1, remote: true },
    { channel: "a:two", payload: 2, remote: false },
  ]);
});
