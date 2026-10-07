// Durable proof for the BROWSER hub connection (web/hub/connection.ts).
// It is built on the global WebSocket rather than the node `ws` client,
// and node 22 ships that same global (undici), which is what lets the
// browser-only connection run headlessly here. The harness boots the
// SAME stub Durable Object as hub-link.mts
// (test/lib/hubStub.mts) and drives the web connection as device A
// against a real node HOST peer (device B, host/hub/connection.ts,
// booted through the shared hubBoot fixture) answering connectInfo.
//
// Asserts: connect, the connectInfo ask round trip (the ONE question
// the orchestration-only hub wire carries) with id correlation, the
// web client refusing a peer's ask as serving no listener, presence propagation, the revoked
// (4102) and superseded (4103) blocked verdicts with no redial, a
// fresh-ticket redial after a drop, and the per-dial ticket mint.
//
// Run: pnpm test web-hub.
import assert from "node:assert/strict";
import { CLOSE_DEVICE_REVOKED, CLOSE_SUPERSEDED } from "@shared/hub/protocol";
import {
  HubAskRefusedError,
  NO_LISTENER_CODE,
  type ServeConnectInfo,
} from "@shared/hub/link";
import { createHubConnection as createWebConnection } from "../web/hub/connection.ts";
import { it } from "vitest";
import { type Track, waitFor } from "./lib/checkKit.mts";
import {
  bootDevice as bootHost,
  type BootDeviceOpts,
  type BootedDevice,
} from "./lib/hubBoot.mts";
import { delay } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { startStubHub, type StubHub } from "./lib/hubStub.mts";

// connectInfo is the only thing the hub wire answers, and the link is
// contract-free, so the host peer's server is a plain echo for the
// round-trip scenarios.
const echoServer: ServeConnectInfo = (_caller, input) => input;
const ASK_MS = 5_000;

// Boots the BROWSER connection (the one under test) on the global
// WebSocket, through the shared boot with the web binding swapped in.
const bootWeb = (
  stub: StubHub,
  deviceId: string,
  track: Track,
  opts: BootDeviceOpts = {},
) =>
  bootHost(
    stub,
    deviceId,
    {
      ...opts,
      createConnection: createWebConnection,
      label: `web ${deviceId}`,
    },
    track,
  );

// Waits until `a` sees `peer` in its roster, so an ask cannot race the
// presence envelope naming it.
const seeing = (a: BootedDevice, peer: string) =>
  waitFor(
    () => a.connection.status().onlineDeviceIds.includes(peer),
    `${peer} to be online`,
  );

it("connect: the browser connection reaches the DO and its status goes connected on the first presence, minting one ticket", async () => {
  const stub = await startStubHub(trackTest);
  const a = await bootWeb(stub, "A", trackTest);
  assert.equal(a.connection.status().socket.phase, "connected");
  assert.equal(a.mints(), 1, "the first dial did not mint exactly one ticket");
});

it("ask: the web client asks a host peer for its connect info, with ids correlating concurrent asks", async () => {
  const stub = await startStubHub(trackTest);
  const a = await bootWeb(stub, "A", trackTest);
  await bootHost(stub, "B", { serveConnectInfo: echoServer }, trackTest);
  await seeing(a, "B");
  const result = await a.connection.askConnectInfo("B", { hi: 1 }, ASK_MS);
  assert.deepEqual(result, { hi: 1 });
  const [first, second] = await Promise.all([
    a.connection.askConnectInfo("B", "one", ASK_MS),
    a.connection.askConnectInfo("B", "two", ASK_MS),
  ]);
  assert.equal(first, "one");
  assert.equal(second, "two");
});

it("serves nobody: a peer asking the web client is refused as serving no direct listener", async () => {
  const stub = await startStubHub(trackTest);
  await bootWeb(stub, "A", trackTest);
  const b = await bootHost(stub, "B", {}, trackTest);
  await seeing(b, "A");
  await assert.rejects(
    () => b.connection.askConnectInfo("A", undefined, ASK_MS),
    (error) =>
      error instanceof HubAskRefusedError && error.code === NO_LISTENER_CODE,
  );
});

it("presence: the web client's status learns a peer is online and drops it when the peer leaves", async () => {
  const stub = await startStubHub(trackTest);
  const a = await bootWeb(stub, "A", trackTest);
  const b = await bootHost(
    stub,
    "B",
    { serveConnectInfo: echoServer },
    trackTest,
  );
  await waitFor(
    () => a.connection.status().onlineDeviceIds.includes("B"),
    "web A to see B online",
  );
  // The local device is filtered out of its own roster.
  assert.equal(
    a.connection.status().onlineDeviceIds.includes("A"),
    false,
    "the web client listed itself as an online peer",
  );
  await b.connection.stop();
  await waitFor(
    () => !a.connection.status().onlineDeviceIds.includes("B"),
    "web A to see B leave",
  );
});

it("blocked: a 4102 revoked close blocks with no redial, and a 4103 superseded close blocks with its own message", async () => {
  const stub = await startStubHub(trackTest);
  const a = await bootWeb(stub, "A", trackTest);
  stub.dropSocket("A", CLOSE_DEVICE_REVOKED, "device revoked");
  await waitFor(
    () => a.connection.status().socket.phase === "blocked",
    "the revoked block",
  );
  const minted = a.mints();
  // Longer than the first backoff rung: a redial would have minted by
  // now.
  await delay(1_300);
  const revoked = a.connection.status().socket;
  assert.equal(revoked.phase, "blocked");
  assert.equal(a.mints(), minted, "a blocked connection redialed");
  assert.match(revoked.message, /removed from the account/);

  const c = await bootWeb(stub, "C", trackTest);
  stub.dropSocket("C", CLOSE_SUPERSEDED, "superseded");
  await waitFor(
    () => c.connection.status().socket.phase === "blocked",
    "the superseded block",
  );
  const superseded = c.connection.status().socket;
  assert(superseded.phase === "blocked");
  assert.match(superseded.message, /another instance/);
});

it("reconnect: a dropped socket redials with a fresh minted ticket and asks a peer again", async () => {
  const stub = await startStubHub(trackTest);
  const a = await bootWeb(stub, "A", trackTest);
  await bootHost(stub, "B", { serveConnectInfo: echoServer }, trackTest);
  assert.equal(a.mints(), 1);
  stub.dropSocket("A", 1001, "going away");
  await waitFor(
    () => a.connection.status().socket.phase === "backoff",
    "the backoff phase",
  );
  await waitFor(
    () => a.connection.status().socket.phase === "connected",
    "the redial",
  );
  // The per-dial mint injection ran again for the redial, proving the
  // web connection mints a fresh ticket per attempt.
  assert.equal(a.mints(), 2, "the redial did not mint a fresh ticket");
  await seeing(a, "B");
  assert.equal(await a.connection.askConnectInfo("B", "back", ASK_MS), "back");
});
