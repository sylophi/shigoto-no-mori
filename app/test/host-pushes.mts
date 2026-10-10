// The host's pushes as a stream (host/lib/hostPushes.ts), published the
// way the broadcast seam does (host/process/bridge.ts): a push reaches a
// subscriber in order with its remote flag, and a push made before the
// graph is up goes nowhere.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import * as HostPushes from "../host/lib/hostPushes.ts";
import * as Bridge from "../host/process/bridge.ts";

it("a published push reaches a subscriber, in order, with its remote flag", async () => {
  const pushes = Bridge.capture<HostPushes.HostPushes>("The host pushes");
  const publish = (push: HostPushes.Push) =>
    pushes.readNow(
      Effect.flatMap(HostPushes.HostPushes, (host) => host.publish(push)),
      () => undefined,
    );
  publish({ channel: "early:push", payload: 0, remote: true });
  const heard = await Effect.gen(function* () {
    const subscribed = yield* (yield* HostPushes.HostPushes).subscribe;
    publish({ channel: "a:one", payload: 1, remote: true });
    publish({ channel: "a:two", payload: 2, remote: false });
    return yield* subscribed.pipe(Stream.take(2), Stream.runCollect);
  }).pipe(
    Effect.scoped,
    Effect.provide(pushes.layer.pipe(Layer.provideMerge(HostPushes.layer))),
    Effect.runPromise,
  );
  assert.deepEqual(heard, [
    { channel: "a:one", payload: 1, remote: true },
    { channel: "a:two", payload: 2, remote: false },
  ]);
});
