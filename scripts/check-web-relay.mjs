// Durable proof for the BROWSER relay connection (web/relay/connection.ts).
// It is built on the global WebSocket rather than the node `ws` client,
// and node 22 ships that same global (undici), which is what lets the
// browser-only connection run headlessly here. The harness boots the SAME
// stub Durable Object as check-relay-link.mjs (a node ws server speaking
// relayObject.ts's envelope, presence, nack and ticket behavior) and
// drives the web connection as device A against a real node HOST peer
// (device B, host/relay/connection.ts) that answers a read-only echo.
//
// Asserts: connect plus a connectPeer hello/welcome that learns the
// peer's appVersion, a peer invoke round trip, presence propagation, the
// revoked (4102) and superseded (4103) blocked verdicts with no redial, a
// fresh-ticket redial after a drop, and the per-dial ticket mint.
//
// Every sm frame the relay carries is wrapped as { epoch, sm } (see the
// SESSION EPOCH note in shared/relay/link.ts), which the stub forwards
// verbatim as the opaque `frame`.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "web:relay:check".
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  decodeEnvelope,
  DeviceEnvelopeSchema,
  encodeEnvelope,
  relayTextWithinLimit,
} from "@shared/relay/protocol";
import { createRelayConnection as createHostConnection } from "@host/relay/connection";
import { createRelayConnection as createWebConnection } from "../web/relay/connection.ts";
import { makeProof } from "./lib/checkKit.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- The stub Durable Object (a focused copy of the relay-link stub) ----

// Tickets are "t:<deviceId>:<n>". The real DO burns single-use tickets,
// but the app side never depends on that, so the stub just parses the
// deviceId out and accepts.
function deviceIdOfTicket(ticket) {
  const parts = ticket.split(":");
  return parts[0] === "t" && parts[1] ? parts[1] : null;
}

function startStubRelay() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sockets = new Map();

    function broadcastPresence() {
      const online = [...sockets.keys()].toSorted();
      const text = encodeEnvelope({ t: "presence", online });
      for (const ws of sockets.values()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      }
    }

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://localhost");
      const deviceId = deviceIdOfTicket(url.searchParams.get("ticket") ?? "");
      if (deviceId === null) {
        ws.close(4101, "ticket rejected");
        return;
      }
      const superseded = sockets.get(deviceId);
      sockets.set(deviceId, ws);
      if (superseded) {
        superseded.close(CLOSE_SUPERSEDED, "superseded");
      }
      broadcastPresence();
      ws.on("message", (data) => {
        const envelope = decodeEnvelope(
          data.toString("utf8"),
          DeviceEnvelopeSchema,
        );
        if (envelope === null) return;
        const target = sockets.get(envelope.to);
        if (target === undefined || target.readyState !== WebSocket.OPEN) {
          ws.send(
            encodeEnvelope({ t: "nack", to: envelope.to, reason: "offline" }),
          );
          return;
        }
        const outbound = encodeEnvelope({
          t: "relay",
          from: deviceId,
          frame: envelope.frame,
        });
        if (!relayTextWithinLimit(outbound)) {
          ws.send(
            encodeEnvelope({ t: "nack", to: envelope.to, reason: "too-large" }),
          );
          return;
        }
        target.send(outbound);
      });
      ws.on("close", () => {
        if (sockets.get(deviceId) === ws) {
          sockets.delete(deviceId);
          broadcastPresence();
        }
      });
    });

    wss.on("listening", () => {
      const { port } = wss.address();
      resolve({
        port,
        relayUrl: `http://127.0.0.1:${port}`,
        // Server-initiated close for one device's socket, the seam the
        // revoked/superseded/reconnect tests drive.
        dropSocket(deviceId, code, reason = "") {
          const ws = sockets.get(deviceId);
          if (ws) ws.close(code, reason);
        },
        close: () =>
          new Promise((done) => {
            for (const ws of sockets.values()) ws.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}

// ---- Device boots ----

// The read-only echo the host peer answers. mutating:false so the
// ungranted web client (which grants nobody) is served it.
function registerEchoHandler(server) {
  server.handle("test:echo", async (_ctx, raw) => raw, { mutating: false });
}

// Boots the node HOST connection as a peer that answers echo, so the web
// client has a real device to dial.
async function bootHost(stub, deviceId, opts = {}, track) {
  let mints = 0;
  const connection = createHostConnection({});
  if (track) track(() => connection.stop());
  registerEchoHandler(connection.server);
  await connection.refresh(async () => ({
    relayUrl: stub.relayUrl,
    accountId: opts.accountId ?? "acct",
    mintTicket: async () => {
      mints += 1;
      return `t:${deviceId}:${mints}`;
    },
    deviceId,
    appVersion: opts.appVersion ?? "1.0.0",
  }));
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `host ${deviceId} to connect`,
  );
  return { connection, mints: () => mints };
}

// Boots the BROWSER connection (the one under test) on the global
// WebSocket.
async function bootWeb(stub, deviceId, opts = {}, track) {
  let mints = 0;
  const connection = createWebConnection({ onPeerPush: opts.onPeerPush });
  if (track) track(() => connection.stop());
  await connection.refresh(async () => ({
    relayUrl: stub.relayUrl,
    accountId: opts.accountId ?? "acct",
    mintTicket: async () => {
      mints += 1;
      return `t:${deviceId}:${mints}`;
    },
    deviceId,
    appVersion: opts.appVersion ?? "1.0.0",
  }));
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `web ${deviceId} to connect`,
  );
  return { connection, mints: () => mints };
}

const { check, done, fail } = makeProof("web relay proof");

async function main() {
  console.log("web relay connection proof\n");

  await check(
    "connect: the browser connection reaches the DO and its status goes connected on the first presence, minting one ticket",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootWeb(stub, "A", {}, track);
      assert.equal(a.connection.status().socket.phase, "connected");
      assert.equal(
        a.mints(),
        1,
        "the first dial did not mint exactly one ticket",
      );
    },
  );

  await check(
    "connectPeer: the web client completes the sm hello/welcome with a host peer and learns its appVersion",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootWeb(stub, "A", {}, track);
      const b = await bootHost(stub, "B", { appVersion: "2.2.2" }, track);
      void b;
      const peer = await a.connection.connectPeer("B");
      assert.equal(peer.remoteDeviceId, "B");
      assert.equal(peer.remoteAppVersion, "2.2.2");
    },
  );

  await check(
    "invoke: a read on the host peer's echo channel round-trips through the relay",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootWeb(stub, "A", {}, track);
      const b = await bootHost(stub, "B", {}, track);
      void b;
      const peer = await a.connection.connectPeer("B");
      const result = await peer.transport.invoke("test:echo", { hi: 1 });
      assert.deepEqual(result, { hi: 1 });
      // Two concurrent invokes prove the id correlation is per call.
      const [first, second] = await Promise.all([
        peer.transport.invoke("test:echo", "one"),
        peer.transport.invoke("test:echo", "two"),
      ]);
      assert.equal(first, "one");
      assert.equal(second, "two");
    },
  );

  await check(
    "presence: the web client's status learns a peer is online and drops it when the peer leaves",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootWeb(stub, "A", {}, track);
      const b = await bootHost(stub, "B", {}, track);
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
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootWeb(stub, "A", {}, track);
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
      assert.match(a.connection.status().socket.message, /revoked/);

      const c = await bootWeb(stub, "C", {}, track);
      stub.dropSocket("C", CLOSE_SUPERSEDED, "superseded");
      await waitFor(
        () => c.connection.status().socket.phase === "blocked",
        "the superseded block",
      );
      assert.match(c.connection.status().socket.message, /another instance/);
    },
  );

  await check(
    "reconnect: a dropped socket redials with a fresh minted ticket and serves a peer again",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootWeb(stub, "A", {}, track);
      const b = await bootHost(stub, "B", {}, track);
      void b;
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
      const peer = await a.connection.connectPeer("B");
      const result = await peer.transport.invoke("test:echo", "back");
      assert.equal(result, "back");
    },
  );

  done();
}

main().catch(fail);
