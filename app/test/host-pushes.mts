// The host's pushes as a stream (host/lib/hostPushes.ts): what the
// broadcast seam publishes reaches a subscriber in order with its remote
// flag, and a push made before the graph is up goes nowhere.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import * as HostPushes from "../host/lib/hostPushes.ts";

it("a published push reaches a subscriber, in order, with its remote flag", async () => {
  HostPushes.publishPush({ channel: "early:push", payload: 0, remote: true });
  const heard = await Effect.gen(function* () {
    const pushes = yield* (yield* HostPushes.HostPushes).subscribe;
    HostPushes.publishPush({ channel: "a:one", payload: 1, remote: true });
    HostPushes.publishPush({ channel: "a:two", payload: 2, remote: false });
    return yield* pushes.pipe(Stream.take(2), Stream.runCollect);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      HostPushes.adapter.pipe(Layer.provideMerge(HostPushes.layer)),
    ),
    Effect.runPromise,
  );
  assert.deepEqual(heard, [
    { channel: "a:one", payload: 1, remote: true },
    { channel: "a:two", payload: 2, remote: false },
  ]);
});
