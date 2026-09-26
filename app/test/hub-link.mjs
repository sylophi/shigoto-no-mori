// Durable proof for the hub transport (shared/hub/link.ts driven
// through host/hub/connection.ts). Boots a STUB Durable Object (a
// node ws server implementing hubObject.ts's envelope behavior:
// deliver forwarding, full-roster presence on join and leave, offline
// and too-large nacks, supersede on a duplicate deviceId) and drives
// real hub connections against it as devices, plus raw stub-side
// sockets where a scenario needs to play a peer by hand.
//
// The device hub carries presence and ONE question between peers, the
// connectInfo ask, as a single ask/answer pair keyed by an id. Asserted:
// one exchange per ask, id correlation across concurrent asks, the
// hub-stamped caller, the void-field framing invariant, error
// serialization (message only), unknown asks refused, the no-listener
// refusal of a device serving nothing, the local outbound size guard
// at the control-frame budget, an oversize answer downgraded to a
// refusal, offline nacks, the per-ask timeout, presence-driven and
// teardown rejection of pending asks, misrouted answers dropped, an
// off-roster ask left unanswered, supervisor redial with a fresh ticket
// per attempt, the blocked verdicts for the revoked and superseded
// close codes, liveness, a frame of another wire shape dropped so the
// ask to its sender times out, and malformed inbound frames dropped
// without killing the process.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. Run: pnpm test hub-link.
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  encodeEnvelope,
} from "@shared/hub/protocol";
import {
  CONNECT_INFO_ASK,
  HubAskRefusedError,
  HubAskTimeoutError,
  HubLinkDownError,
  HubMessageTooLargeError,
  HubPeerOfflineError,
  NO_LISTENER_CODE,
} from "@shared/hub/link";
import { makeProof } from "./lib/checkKit.mjs";
import { bootDevice } from "./lib/hubBoot.mjs";
import { delay, waitFor } from "./lib/checkKit.mjs";
import { startStubHub } from "./lib/hubStub.mjs";

// Larger than MAX_HUB_MESSAGE_BYTES (64 KiB), for the size-guard and
// oversize-answer scenarios.
const OVERSIZE = "x".repeat(70_000);

// The ask timeout the scenarios use when nothing is supposed to time
// out.
const ASK_MS = 5_000;

// The connectInfo server B answers with. The link is contract-free, so
// the scenarios multiplex through the input: echo it (undefined
// included, for the void framing scenario), throw, return an oversize
// result, or name the caller the hub stamped.
function testServer(caller, input) {
  const mode = input !== undefined && input !== null ? input.mode : undefined;
  if (mode === "fail") throw new Error("boom");
  if (mode === "big") return OVERSIZE;
  if (mode === "caller") return caller;
  return input;
}

// The pair most checks boot: the stub, A as a plain asker, and B
// answering with the test server (plus `bOpts`).
async function bootLinked(track, bOpts = {}) {
  const stub = await startStubHub(track);
  const a = await bootDevice(stub, "A", {}, track);
  const b = await bootDevice(
    stub,
    "B",
    { serveConnectInfo: testServer, ...bOpts },
    track,
  );
  await waitFor(
    () => a.connection.status().onlineDeviceIds.includes("B"),
    "A to see B",
  );
  return { stub, a, b };
}

// A raw stub-side device socket, for playing a peer by hand.
function rawDevice(stub, deviceId) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${stub.port}/connect?ticket=${encodeURIComponent(`t:${deviceId}:1`)}`,
  );
  const inbound = [];
  const waiters = [];
  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else inbound.push(parsed);
  });
  const next = () =>
    new Promise((resolve) => {
      const first = inbound.shift();
      if (first) resolve(first);
      else waiters.push(resolve);
    });
  // The next forwarded deliver, skipping presence and nack envelopes.
  const nextHub = async () => {
    const msg = await next();
    return msg.t === "relay" ? msg : nextHub();
  };
  return {
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send: (to, frame) => ws.send(encodeEnvelope({ t: "relay", to, frame })),
    next,
    nextHub,
    close: () => ws.close(),
  };
}

// A booted asker A plus a raw peer B the scenario answers by hand.
async function bootWithRawPeer(track) {
  const stub = await startStubHub(track);
  const a = await bootDevice(stub, "A", {}, track);
  const rawB = rawDevice(stub, "B");
  track(() => rawB.close());
  await rawB.opened;
  await waitFor(
    () => a.connection.status().onlineDeviceIds.includes("B"),
    "A to see raw B",
  );
  return { stub, a, rawB };
}

// An ask frame as a peer on this build sends it.
const askFrame = (id, input) => ({
  ask: CONNECT_INFO_ASK,
  id,
  ...(input === undefined ? {} : { input }),
});

const { check, done, fail } = makeProof("hub-link proof");

async function main() {
  console.log("hub-link transport proof\n");

  await check(
    "ask/answer: one ask is one exchange, ids correlate concurrent asks, and the caller is the device the hub stamped",
    async (track) => {
      const { stub, a } = await bootLinked(track);
      const before = stub.receivedCount();
      const result = await a.connection.askConnectInfo("B", { hi: 1 }, ASK_MS);
      assert.deepEqual(result, { hi: 1 });
      // One frame each way, no handshake around it.
      const exchange = stub.received.slice(before);
      assert.deepEqual(
        exchange.map((entry) => `${entry.from}>${entry.to}`),
        ["A>B", "B>A"],
      );
      assert.equal(exchange[0].frame.ask, CONNECT_INFO_ASK);
      assert.equal(exchange[1].frame.answer, CONNECT_INFO_ASK);
      assert.equal(exchange[1].frame.id, exchange[0].frame.id);
      // Two concurrent asks prove the correlation is per id, not
      // first-come.
      const [first, second] = await Promise.all([
        a.connection.askConnectInfo("B", { n: "one" }, ASK_MS),
        a.connection.askConnectInfo("B", { n: "two" }, ASK_MS),
      ]);
      assert.equal(first.n, "one");
      assert.equal(second.n, "two");
      assert.equal(
        await a.connection.askConnectInfo("B", { mode: "caller" }, ASK_MS),
        "A",
      );
    },
  );

  await check(
    "framing: a void input and a void result ride as absent fields",
    async (track) => {
      const { stub, a } = await bootLinked(track);
      const before = stub.receivedCount();
      const result = await a.connection.askConnectInfo("B", undefined, ASK_MS);
      assert.equal(result, undefined);
      const [ask, answer] = stub.received.slice(before);
      assert.equal("input" in ask.frame, false);
      assert.equal(answer.frame.ok, true);
      assert.equal("result" in answer.frame, false);
    },
  );

  await check(
    "error path: a throwing server answers ok:false with the message only",
    async (track) => {
      const { stub, a } = await bootLinked(track);
      await assert.rejects(
        () => a.connection.askConnectInfo("B", { mode: "fail" }, ASK_MS),
        (error) =>
          error instanceof HubAskRefusedError &&
          error.message === "boom" &&
          error.code === undefined,
      );
      const answer = stub.received.find(
        (entry) => entry.from === "B" && entry.frame.message === "boom",
      );
      assert.ok(answer, "the refusal never reached the stub");
      assert.deepEqual(Object.keys(answer.frame).toSorted(), [
        "answer",
        "id",
        "message",
        "ok",
      ]);
    },
  );

  await check(
    "one ask only: an unknown ask is refused while connectInfo is answered for the same sender",
    async (track) => {
      const stub = await startStubHub(track);
      await bootDevice(stub, "B", { serveConnectInfo: testServer }, track);
      const raw = rawDevice(stub, "C");
      track(() => raw.close());
      await raw.opened;
      await delay(50);
      raw.send("B", { ...askFrame(1), ask: "invokeAnything", input: "x" });
      const refused = await raw.nextHub();
      assert.equal(refused.frame.ok, false);
      assert.match(refused.frame.message, /unknown ask/);
      raw.send("B", askFrame(2, "served"));
      const served = await raw.nextHub();
      assert.equal(served.frame.ok, true);
      assert.equal(served.frame.result, "served");
    },
  );

  await check(
    "no listener: a device with no connectInfo server refuses every ask with the no-listener code",
    async (track) => {
      const stub = await startStubHub(track);
      const a = await bootDevice(stub, "A", {}, track);
      await bootDevice(stub, "D", {}, track);
      await assert.rejects(
        () => a.connection.askConnectInfo("D", undefined, ASK_MS),
        (error) =>
          error instanceof HubAskRefusedError &&
          error.code === NO_LISTENER_CODE &&
          /serves no direct listener/.test(error.message),
      );
    },
  );

  await check(
    "size guard: an oversize ask fails typed WITHOUT hitting the wire, at the control-frame budget",
    async (track) => {
      const { stub, a } = await bootLinked(track);
      const before = stub.receivedCount();
      await assert.rejects(
        () => a.connection.askConnectInfo("B", OVERSIZE, ASK_MS),
        (error) => error instanceof HubMessageTooLargeError,
      );
      assert.equal(
        stub.receivedCount(),
        before,
        "the oversize frame reached the stub",
      );
    },
  );

  await check(
    "oversize answer: a result too large for one envelope is refused at once, not left to time out",
    async (track) => {
      const { a } = await bootLinked(track);
      const startedAt = Date.now();
      await assert.rejects(
        () => a.connection.askConnectInfo("B", { mode: "big" }, ASK_MS),
        (error) =>
          error instanceof HubAskRefusedError &&
          /too large/.test(error.message),
      );
      assert.ok(Date.now() - startedAt < 1_000, "the refusal waited");
    },
  );

  await check(
    "offline nack: asking a deviceId with no socket rejects with the offline error",
    async (track) => {
      const stub = await startStubHub(track);
      const a = await bootDevice(stub, "A", {}, track);
      await assert.rejects(
        () => a.connection.askConnectInfo("ghost", undefined, ASK_MS),
        (error) => error instanceof HubPeerOfflineError,
      );
    },
  );

  await check(
    "timeout: a peer that never answers fails the ask typed at its timeout, and the late answer is dropped",
    async (track) => {
      const { a, rawB } = await bootWithRawPeer(track);
      const pending = a.connection.askConnectInfo("B", "hello?", 200);
      const ask = await rawB.nextHub();
      await assert.rejects(
        () => pending,
        (error) => error instanceof HubAskTimeoutError,
      );
      // Answering after the timeout finds nothing to resolve and harms
      // nothing: the link still asks and answers.
      rawB.send("A", {
        answer: CONNECT_INFO_ASK,
        id: ask.frame.id,
        ok: true,
        result: "late",
      });
      await delay(50);
      const again = a.connection.askConnectInfo("B", "again", ASK_MS);
      const second = await rawB.nextHub();
      rawB.send("A", {
        answer: CONNECT_INFO_ASK,
        id: second.frame.id,
        ok: true,
        result: "fresh",
      });
      assert.equal(await again, "fresh");
    },
  );

  await check(
    "presence: a peer leaving the roster fails the ask pending to it typed",
    async (track) => {
      const { a, rawB } = await bootWithRawPeer(track);
      const pending = a.connection.askConnectInfo("B", "hello?", ASK_MS);
      await rawB.nextHub();
      rawB.close();
      await assert.rejects(
        () => pending,
        (error) => error instanceof HubPeerOfflineError,
      );
    },
  );

  await check(
    "teardown: stopping the connection fails pending asks as link-down, and later asks reject at once",
    async (track) => {
      const { a, rawB } = await bootWithRawPeer(track);
      const pending = a.connection.askConnectInfo("B", "hello?", ASK_MS);
      await rawB.nextHub();
      await a.connection.stop();
      await assert.rejects(
        () => pending,
        (error) => error instanceof HubLinkDownError,
      );
      await assert.rejects(
        () => a.connection.askConnectInfo("B", "after", ASK_MS),
        (error) => error instanceof HubLinkDownError,
      );
    },
  );

  await check(
    "misrouted answer: an answer from a device other than the one asked is dropped",
    async (track) => {
      const { stub, a, rawB } = await bootWithRawPeer(track);
      const rawC = rawDevice(stub, "C");
      track(() => rawC.close());
      await rawC.opened;
      const pending = a.connection.askConnectInfo("B", "hello?", ASK_MS);
      const ask = await rawB.nextHub();
      const answer = (result) => ({
        answer: CONNECT_INFO_ASK,
        id: ask.frame.id,
        ok: true,
        result,
      });
      rawC.send("A", answer("from C"));
      await delay(50);
      rawB.send("A", answer("from B"));
      assert.equal(await pending, "from B");
    },
  );

  await check(
    "off-roster ask: an ask whose from is not in the presence roster gets no answer",
    async (track) => {
      const stub = await startStubHub(track);
      await bootDevice(stub, "B", { serveConnectInfo: testServer }, track);
      // Forge a deliver to B from a device that is not in B's roster (a
      // hostile hub can set any `from`). B must answer nothing.
      stub.injectTo("B", { t: "relay", from: "ghost", frame: askFrame(1) });
      await delay(200);
      assert.equal(
        stub.sentTo("B", "ghost"),
        false,
        "B answered an off-roster sender",
      );
    },
  );

  await check(
    "unknown wire shape: a frame this link does not speak is dropped, so an ask to such a peer times out like any unreachable one and the link keeps serving",
    async (track) => {
      const { a, rawB } = await bootWithRawPeer(track);
      const pending = a.connection.askConnectInfo("B", "x", 200);
      const ask = await rawB.nextHub();
      // What a build speaking another wire would say: neither an ask
      // nor an answer, so nothing routes it to the pending ask.
      rawB.send("A", { epoch: 0, sm: { t: "welcome", deviceId: "B" } });
      await assert.rejects(
        () => pending,
        (error) => error instanceof HubAskTimeoutError,
      );
      const again = a.connection.askConnectInfo("B", "again", ASK_MS);
      const second = await rawB.nextHub();
      assert.notEqual(second.frame.id, ask.frame.id);
      rawB.send("A", {
        answer: CONNECT_INFO_ASK,
        id: second.frame.id,
        ok: true,
        result: "fresh",
      });
      assert.equal(await again, "fresh");
    },
  );

  await check(
    "reconnect: a dropped socket redials with a fresh ticket and answers again",
    async (track) => {
      const { stub, a } = await bootLinked(track);
      assert.equal(a.mints(), 1);
      stub.dropSocket("A", 1001, "going away");
      await waitFor(
        () => a.connection.status().socket.phase === "backoff",
        "the backoff phase",
      );
      // The first backoff rung is 1s, so the redial (with its fresh
      // ticket mint) lands shortly after.
      await waitFor(
        () => a.connection.status().socket.phase === "connected",
        "the redial",
      );
      assert.equal(a.mints(), 2, "the redial did not mint a fresh ticket");
      await waitFor(
        () => a.connection.status().onlineDeviceIds.includes("B"),
        "A to see B again",
      );
      assert.equal(
        await a.connection.askConnectInfo("B", "back", ASK_MS),
        "back",
      );
    },
  );

  await check(
    "blocked: 4102 revoked blocks with no redial, 4103 superseded blocks with its own message",
    async (track) => {
      const stub = await startStubHub(track);
      const a = await bootDevice(stub, "A", {}, track);
      stub.dropSocket("A", CLOSE_DEVICE_REVOKED, "device revoked");
      await waitFor(
        () => a.connection.status().socket.phase === "blocked",
        "the blocked phase",
      );
      const minted = a.mints();
      // Longer than the first backoff rung: a redial would have minted
      // by now.
      await delay(1_300);
      assert.equal(a.connection.status().socket.phase, "blocked");
      assert.equal(a.mints(), minted, "a blocked supervisor redialed");
      assert.match(
        a.connection.status().socket.message,
        /removed from the account/,
      );
      // A fresh device for the superseded arm, booted inside the tracked
      // scope so a failure here still closes the stub.
      const c = await bootDevice(stub, "C", {}, track);
      stub.dropSocket("C", CLOSE_SUPERSEDED, "superseded");
      await waitFor(
        () => c.connection.status().socket.phase === "blocked",
        "the superseded block",
      );
      assert.match(c.connection.status().socket.message, /another instance/);
    },
  );

  await check(
    "liveness: a device heartbeats the device hub, and a hub that stops answering (or never answered) is declared dead and redialed with a fresh ticket",
    async (track) => {
      const stub = await startStubHub(track);
      const heartbeat = { intervalMs: 30, timeoutMs: 120 };
      const a = await bootDevice(stub, "A", { heartbeat }, track);
      await waitFor(() => stub.pingsFrom("A") >= 2, "A to heartbeat");
      assert.equal(
        a.connection.status().socket.phase,
        "connected",
        "an answered heartbeat keeps the socket connected",
      );
      assert.equal(a.mints(), 1);
      // The hub goes silent: its socket is still open at the TCP level,
      // exactly the shape of a flow a NAT or a sleep killed.
      stub.setAnswerPings(false);
      await waitFor(
        () => a.mints() >= 2,
        "A to declare the silent hub dead and redial",
        3_000,
      );
      // The redial lands against a hub that answers again, and the
      // supervisor's ladder started from the bottom (a stable socket
      // that died resets it), so the connection is back at once.
      stub.setAnswerPings(true);
      await waitFor(
        () => a.connection.status().socket.phase === "connected",
        "A to reconnect after the heartbeat death",
        3_000,
      );

      // No latch on this side: a hub that NEVER answers (a Worker
      // predating the pair) is redialed too, so a socket that dies
      // before its first pong is still found. That is the deploy order
      // hub/README.md states, and the cost of getting it wrong is a
      // redial per timeout, not a dead device.
      stub.setAnswerPings(false);
      const b = await bootDevice(stub, "B", { heartbeat }, track);
      await waitFor(
        () => b.mints() >= 2,
        "B to redial a hub that never answered",
        3_000,
      );
      stub.setAnswerPings(true);
    },
  );

  await check(
    "malformed inbound: garbage frames are dropped without killing the process",
    async (track) => {
      const { stub, a } = await bootLinked(track);
      // Non-JSON text, an unparseable envelope, and a valid envelope
      // whose frame is neither the ask nor the answer.
      // All must be dropped, not fatal.
      stub.injectTo("A", "this is not json at all");
      stub.injectTo("A", { t: "totally-unknown" });
      stub.injectTo("A", { t: "relay", from: "B", frame: { t: "bogus" } });
      await delay(150);
      // The link is still live: a real ask still works.
      assert.equal(
        await a.connection.askConnectInfo("B", "alive", ASK_MS),
        "alive",
      );
    },
  );

  done();
}

main().catch(fail);
