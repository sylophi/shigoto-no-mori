// Proof for the mirror gateway's lifetime (host/mirror/MirrorGateway.ts):
// the loopback listener the mirror daemon dials peers through is held by
// the layer's scope, and so is the retry of a bind that failed. The
// listen itself is stood in at node's net.Server, failing or held as a
// check needs, and the clock is a TestClock that outlives the layer.
//
// Asserts:
//   - a bind that fails is tried again on its 30 s schedule, and once
//     the layer has closed no retry runs and nothing is left bound,
//   - a layer that closes while a retry's bind is under way waits for
//     it and closes the listener it bound, which never reads as
//     listening.
//
// Run: pnpm test mirror-gateway.
import assert from "node:assert/strict";
import { Server } from "node:net";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { afterAll, afterEach, it } from "vitest";
import * as PeerReach from "../host/ipc/PeerReach.ts";
import * as MirrorGateway from "../host/mirror/MirrorGateway.ts";
import { settleTurns, testClock } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

const notHere = () => Promise.reject(new Error("not in this check"));

// Every loopback listen on an ephemeral port, the gateway's: what the
// next one does, and the servers it was asked of.
const realListen = Server.prototype.listen;
const listens: { server: Server; finish: () => void }[] = [];
let next: "fail" | "hold" | "bind" = "bind";
function standInListen(this: Server, ...args: unknown[]): Server {
  if (args[0] !== 0 || args[1] !== "127.0.0.1") {
    return Reflect.apply(realListen, this, args);
  }
  const bind = () => Reflect.apply(realListen, this, args);
  const fail = () =>
    this.emit(
      "error",
      Object.assign(new Error("listen EADDRNOTAVAIL"), {
        code: "EADDRNOTAVAIL",
      }),
    );
  const mode = next;
  const finish = mode === "fail" ? fail : bind;
  listens.push({ server: this, finish });
  if (mode !== "hold") process.nextTick(finish);
  return this;
}
Server.prototype.listen = standInListen as typeof Server.prototype.listen;
afterAll(() => {
  Server.prototype.listen = realListen;
});
afterEach(() => {
  listens.length = 0;
  next = "bind";
});

const start = async () => {
  const clock = testClock();
  const gateway = ManagedRuntime.make(
    MirrorGateway.layer.pipe(
      Layer.provide(
        Layer.succeed(
          PeerReach.PeerReach,
          PeerReach.make({
            transportFor: () => ({
              invoke: notHere,
              subscribe: () => () => {},
            }),
            channelsFor: () => notHere,
          }),
        ),
      ),
      Layer.provide(Layer.succeedContext(clock.context)),
    ),
  );
  trackTest(() => gateway.dispose());
  await gateway.context();
  const listening = () =>
    gateway.runSync(MirrorGateway.MirrorGateway.use((gw) => gw.listening));
  return { clock, gateway, listening };
};

it("a bind that failed is retried on its schedule, and none runs once the layer closed", async () => {
  next = "fail";
  const { clock, gateway, listening } = await start();
  assert.equal(listens.length, 1);
  assert.ok(Option.isNone(listening()));
  await clock.advance(29_000);
  assert.equal(listens.length, 1, "retried before its 30 s");
  await clock.advance(1_000);
  assert.equal(listens.length, 2, "not retried at 30 s");
  await gateway.dispose();
  next = "bind";
  await clock.advance(10 * 60_000);
  await settleTurns();
  assert.equal(listens.length, 2, "a retry ran after the layer closed");
  assert.ok(
    listens.every(({ server }) => !server.listening),
    "a listener outlived the layer",
  );
});

it("a close while a retry binds waits for the bind and closes what it bound", async () => {
  next = "fail";
  const { clock, gateway } = await start();
  next = "hold";
  await clock.advance(30_000);
  const held = listens.at(-1);
  assert.ok(held !== undefined && listens.length === 2, "no retry under way");
  const closed = gateway.dispose();
  await settleTurns();
  held.finish();
  await closed;
  await settleTurns();
  assert.equal(held.server.listening, false, "the bind outlived the close");
  await clock.advance(10 * 60_000);
  assert.equal(listens.length, 2, "a retry ran after the layer closed");
});
