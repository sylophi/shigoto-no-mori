// Durable proof for the BROWSER hub connection (web/hub/connection.ts).
// It is built on the global WebSocket rather than the node `ws` client,
// and node 22 ships that same global (undici), which is what lets the
// browser-only connection run headlessly here. The harness boots the
// SAME stub Durable Object as hub-link.mjs
// (test/lib/hubStub.mjs) and drives the web connection as device A
// against a real node HOST peer (device B, host/hub/connection.ts,
// booted through the shared hubBoot fixture) answering connectInfo.
//
// Asserts: connect, the connectInfo ask round trip (the ONE question
// the orchestration-only hub wire carries) with id correlation, the
// web client refusing a peer's ask as serving no listener, presence propagation, the revoked
// (4102) and superseded (4103) blocked verdicts with no redial, a
// fresh-ticket redial after a drop, and the per-dial ticket mint.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. Run: pnpm test web-hub.
import assert from "node:assert/strict";
import { CLOSE_DEVICE_REVOKED, CLOSE_SUPERSEDED } from "@shared/hub/protocol";
import { HubAskRefusedError, NO_LISTENER_CODE } from "@shared/hub/link";
import { createHubConnection as createWebConnection } from "../web/hub/connection.ts";
import { makeProof } from "./lib/checkKit.mjs";
import { bootDevice as bootHost } from "./lib/hubBoot.mjs";
import { delay, waitFor } from "./lib/checkKit.mjs";
import { startStubHub } from "./lib/hubStub.mjs";

// connectInfo is the only thing the hub wire answers, and the link is
// contract-free, so the host peer's server is a plain echo for the
// round-trip scenarios.
const echoServer = (_caller, input) => input;
const ASK_MS = 5_000;

// Boots the BROWSER connection (the one under test) on the global
// WebSocket, through the shared boot with the web binding swapped in.
const bootWeb = (stub, deviceId, track, opts = {}) =>
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
const seeing = (a, peer) =>
  waitFor(
    () => a.connection.status().onlineDeviceIds.includes(peer),
    `${peer} to be online`,
  );

const { check, done, fail } = makeProof("web hub proof");

async function main() {
  console.log("web hub connection proof\n");

  await check(
    "connect: the browser connection reaches the DO and its status goes connected on the first presence, minting one ticket",
    async (track) => {
      const stub = await startStubHub(track);
      const a = await bootWeb(stub, "A", track);
      assert.equal(a.connection.status().socket.phase, "connected");
      assert.equal(
        a.mints(),
        1,
        "the first dial did not mint exactly one ticket",
      );
    },
  );

  await check(
    "ask: the web client asks a host peer for its connect info, with ids correlating concurrent asks",
    async (track) => {
      const stub = await startStubHub(track);
      const a = await bootWeb(stub, "A", track);
      await bootHost(stub, "B", { serveConnectInfo: echoServer }, track);
      await seeing(a, "B");
      const result = await a.connection.askConnectInfo("B", { hi: 1 }, ASK_MS);
      assert.deepEqual(result, { hi: 1 });
      const [first, second] = await Promise.all([
        a.connection.askConnectInfo("B", "one", ASK_MS),
        a.connection.askConnectInfo("B", "two", ASK_MS),
      ]);
      assert.equal(first, "one");
      assert.equal(second, "two");
    },
  );

  await check(
    "serves nobody: a peer asking the web client is refused as serving no direct listener",
    async (track) => {
      const stub = await startStubHub(track);
      await bootWeb(stub, "A", track);
      const b = await bootHost(stub, "B", {}, track);
      await seeing(b, "A");
      await assert.rejects(
        () => b.connection.askConnectInfo("A", undefined, ASK_MS),
        (error) =>
          error instanceof HubAskRefusedError &&
          error.code === NO_LISTENER_CODE,
      );
    },
  );

  await check(
    "presence: the web client's status learns a peer is online and drops it when the peer leaves",
    async (track) => {
      const stub = await startStubHub(track);
      const a = await bootWeb(stub, "A", track);
      const b = await bootHost(
        stub,
        "B",
        { serveConnectInfo: echoServer },
        track,
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
    },
  );

  await check(
    "blocked: a 4102 revoked close blocks with no redial, and a 4103 superseded close blocks with its own message",
    async (track) => {
      const stub = await startStubHub(track);
      const a = await bootWeb(stub, "A", track);
      stub.dropSocket("A", CLOSE_DEVICE_REVOKED, "device revoked");
      await waitFor(
        () => a.connection.status().socket.phase === "blocked",
        "the revoked block",
      );
      const minted = a.mints();
      // Longer than the first backoff rung: a redial would have minted by
      // now.
      await delay(1_300);
      assert.equal(a.connection.status().socket.phase, "blocked");
      assert.equal(a.mints(), minted, "a blocked connection redialed");
      assert.match(
        a.connection.status().socket.message,
        /removed from the account/,
      );

      const c = await bootWeb(stub, "C", track);
      stub.dropSocket("C", CLOSE_SUPERSEDED, "superseded");
      await waitFor(
        () => c.connection.status().socket.phase === "blocked",
        "the superseded block",
      );
      assert.match(c.connection.status().socket.message, /another instance/);
    },
  );

  await check(
    "reconnect: a dropped socket redials with a fresh minted ticket and asks a peer again",
    async (track) => {
      const stub = await startStubHub(track);
      const a = await bootWeb(stub, "A", track);
      await bootHost(stub, "B", { serveConnectInfo: echoServer }, track);
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
      assert.equal(
        await a.connection.askConnectInfo("B", "back", ASK_MS),
        "back",
      );
    },
  );

  done();
}

main().catch(fail);
