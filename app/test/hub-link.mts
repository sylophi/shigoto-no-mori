// Durable proof for the hub transport (shared/hub/link.ts driven
// through host/hub/connection.ts). Boots a STUB Durable Object (a
// node ws server implementing hubObject.ts's envelope behavior:
// deliver forwarding, full-roster presence on join and leave, offline
// and too-large nacks, supersede on a duplicate deviceId) and drives
// real hub connections against it as devices, plus raw stub-side
// sockets where a scenario needs to play a peer by hand.
//
// The device hub carries presence and ONE question between peers, the
// connectInfo ask, as a single ask/answer pair keyed by an id and
// sealed as a Noise IK handshake to the keys the roster names. Asserted:
// one exchange per ask with nothing readable on the hub, id correlation
// across concurrent asks, the hub-stamped caller, an ask sealed under a
// key other than the roster's and a tampered answer refused, the
// void-field framing invariant, error
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
// Run: pnpm test hub-link.
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import * as Schema from "effect/Schema";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  decodeRelayFrame,
  encodeEnvelope,
  encodeRelayFrame,
  type RelayFrame,
  type ServerEnvelope,
} from "@shigomori/contracts/hubProtocol";
import { fromBase64Url, toBase64Url } from "@shared/crypto/deviceKey";
import { generateKeyPair, HandshakeState } from "@shared/crypto/noise";
import {
  CONNECT_INFO_ASK,
  relayPrologue,
  HubAskRefusedError,
  HubAskTimeoutError,
  HubLinkDownError,
  HubMessageTooLargeError,
  HubPeerOfflineError,
  NO_LISTENER_CODE,
} from "@shared/hub/link";
import { it } from "vitest";
import { type Track, waitFor } from "./lib/checkKit.mts";
import { bootDevice, type BootDeviceOpts } from "./lib/hubBoot.mts";
import { delay } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import {
  sealAsk,
  startStubHub,
  type StubHub,
  testDeviceKey,
} from "./lib/hubStub.mts";

// Larger than MAX_HUB_MESSAGE_BYTES (64 KiB), for the size-guard and
// oversize-answer scenarios.
const OVERSIZE = "x".repeat(70_000);

// The ask timeout the scenarios use when nothing is supposed to time
// out.
const ASK_MS = 5_000;

// A plain object's fields, for values that are not ask/answer frames
// and for the raw key set of one (the frame schemas strip unknown
// keys).
const fields = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value);

// The connectInfo server B answers with. The link is contract-free, so
// the scenarios multiplex through the input: echo it (undefined
// included, for the void framing scenario), throw, return an oversize
// result, or name the caller the hub stamped.
function testServer(caller: string, input: unknown) {
  const mode =
    typeof input === "object" && input !== null && "mode" in input
      ? input.mode
      : undefined;
  if (mode === "fail") throw new Error("boom");
  if (mode === "big") return OVERSIZE;
  if (mode === "caller") return caller;
  return input;
}

// The pair most checks boot: the stub, A as a plain asker, and B
// answering with the test server (plus `bOpts`).
async function bootLinked(track: Track, bOpts: BootDeviceOpts = {}) {
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
function rawDevice(stub: StubHub, deviceId: string) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${stub.port}/connect?ticket=${encodeURIComponent(`t:${deviceId}:1`)}`,
  );
  const inbound: ServerEnvelope[] = [];
  const waiters: ((msg: ServerEnvelope) => void)[] = [];
  ws.on("message", (data) => {
    const parsed: ServerEnvelope = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else inbound.push(parsed);
  });
  const next = () =>
    new Promise<ServerEnvelope>((resolve) => {
      const first = inbound.shift();
      if (first) resolve(first);
      else waiters.push(resolve);
    });
  // The next forwarded deliver, skipping presence and nack envelopes.
  const nextHub = async (): Promise<
    Extract<ServerEnvelope, { t: "relay" }>
  > => {
    const msg = await next();
    return msg.t === "relay" ? msg : nextHub();
  };
  return {
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send: (to: string, frame: string) =>
      ws.send(encodeEnvelope({ t: "relay", to, frame })),
    next,
    nextHub,
    close: () => ws.close(),
  };
}

// A booted asker A plus a raw peer B the scenario answers by hand.
async function bootWithRawPeer(track: Track) {
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

// Playing a peer by hand: what a device on this build seals and opens.
const utf8 = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const json = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder().decode(bytes));

function frameOf(text: string): RelayFrame {
  const frame = decodeRelayFrame(text);
  assert.ok(frame !== null, `not a relay frame: ${text.slice(0, 40)}`);
  return frame;
}

const connectInfoAsk = (input?: unknown) => ({
  ask: CONNECT_INFO_ASK,
  ...(input === undefined ? {} : { input }),
});

// Opens an ask `from` sent to `self`, answering its id, payload and the
// handshake the answer is sealed with.
function openAsk(from: string, self: string, text: string) {
  const frame = frameOf(text);
  assert.equal(frame.kind, "ask");
  const handshake = new HandshakeState({
    initiator: false,
    prologue: relayPrologue(from, self),
    s: testDeviceKey(self).pair,
  });
  const payload = json(
    handshake.readMessage(fromBase64Url(frame.sealed)).payload,
  );
  return { id: frame.id, payload, handshake };
}

function sealAnswer(
  handshake: HandshakeState,
  id: number,
  payload: unknown,
): string {
  const sealed = toBase64Url(handshake.writeMessage(utf8(payload)).message);
  return encodeRelayFrame({ kind: "answer", id, sealed });
}

function openAnswer(handshake: HandshakeState, text: string): unknown {
  const frame = frameOf(text);
  assert.equal(frame.kind, "answer");
  return json(handshake.readMessage(fromBase64Url(frame.sealed)).payload);
}

it("ask/answer: one ask is one exchange, ids correlate concurrent asks, and the caller is the device the hub stamped", async () => {
  const { stub, a } = await bootLinked(trackTest);
  const before = stub.receivedCount();
  const result = await a.connection.askConnectInfo("B", { hi: 1 }, ASK_MS);
  assert.deepEqual(result, { hi: 1 });
  // One frame each way, and nothing in either the hub can read.
  const exchange = stub.received.slice(before);
  assert.deepEqual(
    exchange.map((entry) => `${entry.from}>${entry.to}`),
    ["A>B", "B>A"],
  );
  const [askEntry, answerEntry] = exchange;
  assert.ok(
    askEntry !== undefined && answerEntry !== undefined,
    "the ask and its answer were not both received",
  );
  const askSent = frameOf(askEntry.frame);
  const answerSent = frameOf(answerEntry.frame);
  assert.equal(askSent.kind, "ask");
  assert.equal(answerSent.kind, "answer");
  assert.equal(answerSent.id, askSent.id);
  for (const entry of exchange) {
    assert.doesNotMatch(entry.frame, /connectInfo|"hi"/);
  }
  // Two concurrent asks prove the correlation is per id, not
  // first-come.
  const [first, second] = await Promise.all([
    a.connection.askConnectInfo("B", { n: "one" }, ASK_MS),
    a.connection.askConnectInfo("B", { n: "two" }, ASK_MS),
  ]);
  assert.equal(fields(first).n, "one");
  assert.equal(fields(second).n, "two");
  assert.equal(
    await a.connection.askConnectInfo("B", { mode: "caller" }, ASK_MS),
    "A",
  );
});

it("framing: a void input and a void result ride as absent fields", async () => {
  const { a, rawB } = await bootWithRawPeer(trackTest);
  const pending = a.connection.askConnectInfo("B", undefined, ASK_MS);
  const ask = openAsk("A", "B", (await rawB.nextHub()).frame);
  assert.deepEqual(ask.payload, { ask: CONNECT_INFO_ASK });
  rawB.send("A", sealAnswer(ask.handshake, ask.id, { ok: true }));
  assert.equal(await pending, undefined);
});

it("keys: an ask sealed with a key other than the roster's gets no answer, and a tampered answer is refused", async () => {
  const stub = await startStubHub(trackTest);
  await bootDevice(stub, "B", { serveConnectInfo: testServer }, trackTest);
  const rawC = rawDevice(stub, "C");
  trackTest(() => rawC.close());
  await rawC.opened;
  await delay(50);
  // C is on the roster, but seals with a key it did not enroll with.
  rawC.send(
    "B",
    sealAsk("C", "B", 1, connectInfoAsk("x"), generateKeyPair()).frame,
  );
  await delay(150);
  assert.equal(stub.sentTo("B", "C"), false, "B answered a wrong key");
  // Sealed for B but delivered as if from another device: the prologue
  // names the asker, so it does not open either.
  stub.injectTo("B", {
    t: "relay",
    from: "C",
    frame: sealAsk("D", "B", 2, connectInfoAsk("x"), testDeviceKey("C").pair)
      .frame,
  });
  await delay(150);
  assert.equal(stub.sentTo("B", "C"), false, "B answered a misdirected ask");

  const { a, rawB } = await bootWithRawPeer(trackTest);
  const pending = a.connection.askConnectInfo("B", "hello?", ASK_MS);
  const ask = openAsk("A", "B", (await rawB.nextHub()).frame);
  const answer = frameOf(sealAnswer(ask.handshake, ask.id, { ok: true }));
  const flipped = fromBase64Url(answer.sealed);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
  rawB.send("A", encodeRelayFrame({ ...answer, sealed: toBase64Url(flipped) }));
  await assert.rejects(
    () => pending,
    (error) =>
      error instanceof HubAskRefusedError && /did not open/.test(error.message),
  );
});

it("error path: a throwing server answers ok:false with the message only", async () => {
  const { a } = await bootLinked(trackTest);
  await assert.rejects(
    () => a.connection.askConnectInfo("B", { mode: "fail" }, ASK_MS),
    (error) =>
      error instanceof HubAskRefusedError &&
      error.message === "boom" &&
      error.code === undefined,
  );
  const stub = await startStubHub(trackTest);
  await bootDevice(stub, "B", { serveConnectInfo: testServer }, trackTest);
  const raw = rawDevice(stub, "C");
  trackTest(() => raw.close());
  await raw.opened;
  await delay(50);
  const ask = sealAsk("C", "B", 1, connectInfoAsk({ mode: "fail" }));
  raw.send("B", ask.frame);
  const answer = openAnswer(ask.handshake, (await raw.nextHub()).frame);
  assert.deepEqual(Object.keys(fields(answer)).toSorted(), ["message", "ok"]);
});

it("one ask only: an unknown ask is refused while connectInfo is answered for the same sender", async () => {
  const stub = await startStubHub(trackTest);
  await bootDevice(stub, "B", { serveConnectInfo: testServer }, trackTest);
  const raw = rawDevice(stub, "C");
  trackTest(() => raw.close());
  await raw.opened;
  await delay(50);
  const unknown = sealAsk("C", "B", 1, { ask: "invokeAnything", input: "x" });
  raw.send("B", unknown.frame);
  const refused = fields(
    openAnswer(unknown.handshake, (await raw.nextHub()).frame),
  );
  assert.equal(refused.ok, false);
  assert.match(String(refused.message), /unknown ask/);
  const known = sealAsk("C", "B", 2, connectInfoAsk("served"));
  raw.send("B", known.frame);
  const served = fields(
    openAnswer(known.handshake, (await raw.nextHub()).frame),
  );
  assert.equal(served.ok, true);
  assert.equal(served.result, "served");
});

it("no listener: a device with no connectInfo server refuses every ask with the no-listener code", async () => {
  const stub = await startStubHub(trackTest);
  const a = await bootDevice(stub, "A", {}, trackTest);
  await bootDevice(stub, "D", {}, trackTest);
  await assert.rejects(
    () => a.connection.askConnectInfo("D", undefined, ASK_MS),
    (error) =>
      error instanceof HubAskRefusedError &&
      error.code === NO_LISTENER_CODE &&
      /serves no direct listener/.test(error.message),
  );
});

it("size guard: an oversize ask fails typed WITHOUT hitting the wire, at the control-frame budget", async () => {
  const { stub, a } = await bootLinked(trackTest);
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
});

it("oversize answer: a result too large for one envelope is refused at once, not left to time out", async () => {
  const { a } = await bootLinked(trackTest);
  const startedAt = Date.now();
  await assert.rejects(
    () => a.connection.askConnectInfo("B", { mode: "big" }, ASK_MS),
    (error) =>
      error instanceof HubAskRefusedError && /too large/.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 1_000, "the refusal waited");
});

it("offline nack: asking a deviceId with no socket rejects with the offline error", async () => {
  const stub = await startStubHub(trackTest);
  const a = await bootDevice(stub, "A", {}, trackTest);
  await assert.rejects(
    () => a.connection.askConnectInfo("ghost", undefined, ASK_MS),
    (error) => error instanceof HubPeerOfflineError,
  );
});

it("timeout: a peer that never answers fails the ask typed at its timeout, and the late answer is dropped", async () => {
  const { a, rawB } = await bootWithRawPeer(trackTest);
  const pending = a.connection.askConnectInfo("B", "hello?", 200);
  const ask = openAsk("A", "B", (await rawB.nextHub()).frame);
  await assert.rejects(
    () => pending,
    (error) => error instanceof HubAskTimeoutError,
  );
  // Answering after the timeout finds nothing to resolve and harms
  // nothing: the link still asks and answers.
  rawB.send(
    "A",
    sealAnswer(ask.handshake, ask.id, { ok: true, result: "late" }),
  );
  await delay(50);
  const again = a.connection.askConnectInfo("B", "again", ASK_MS);
  const second = openAsk("A", "B", (await rawB.nextHub()).frame);
  rawB.send(
    "A",
    sealAnswer(second.handshake, second.id, { ok: true, result: "fresh" }),
  );
  assert.equal(await again, "fresh");
});

it("presence: a peer leaving the roster fails the ask pending to it typed", async () => {
  const { a, rawB } = await bootWithRawPeer(trackTest);
  const pending = a.connection.askConnectInfo("B", "hello?", ASK_MS);
  await rawB.nextHub();
  rawB.close();
  await assert.rejects(
    () => pending,
    (error) => error instanceof HubPeerOfflineError,
  );
});

it("teardown: stopping the connection fails pending asks as link-down, and later asks reject at once", async () => {
  const { a, rawB } = await bootWithRawPeer(trackTest);
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
});

it("misrouted answer: an answer from a device other than the one asked is dropped", async () => {
  const { stub, a, rawB } = await bootWithRawPeer(trackTest);
  const rawC = rawDevice(stub, "C");
  trackTest(() => rawC.close());
  await rawC.opened;
  const pending = a.connection.askConnectInfo("B", "hello?", ASK_MS);
  const ask = openAsk("A", "B", (await rawB.nextHub()).frame);
  // C copies the answer B is about to send, word for word.
  const answer = sealAnswer(ask.handshake, ask.id, {
    ok: true,
    result: "from B",
  });
  rawC.send("A", answer);
  await delay(50);
  rawB.send("A", answer);
  assert.equal(await pending, "from B");
});

it("off-roster ask: an ask whose from is not in the presence roster gets no answer", async () => {
  const stub = await startStubHub(trackTest);
  await bootDevice(stub, "B", { serveConnectInfo: testServer }, trackTest);
  // Forge a deliver to B from a device that is not in B's roster (a
  // hostile hub can set any `from`). B must answer nothing.
  stub.injectTo("B", {
    t: "relay",
    from: "ghost",
    frame: sealAsk("ghost", "B", 1, connectInfoAsk()).frame,
  });
  await delay(200);
  assert.equal(
    stub.sentTo("B", "ghost"),
    false,
    "B answered an off-roster sender",
  );
});

it("unknown wire shape: a frame this link does not speak is dropped, so an ask to such a peer times out like any unreachable one and the link keeps serving", async () => {
  const { a, rawB } = await bootWithRawPeer(trackTest);
  const pending = a.connection.askConnectInfo("B", "x", 200);
  const ask = openAsk("A", "B", (await rawB.nextHub()).frame);
  // What a build speaking another wire would say: neither an ask
  // nor an answer, so nothing routes it to the pending ask.
  rawB.send("A", JSON.stringify({ epoch: 0, sm: { t: "welcome" } }));
  await assert.rejects(
    () => pending,
    (error) => error instanceof HubAskTimeoutError,
  );
  const again = a.connection.askConnectInfo("B", "again", ASK_MS);
  const second = openAsk("A", "B", (await rawB.nextHub()).frame);
  assert.notEqual(second.id, ask.id);
  rawB.send(
    "A",
    sealAnswer(second.handshake, second.id, { ok: true, result: "fresh" }),
  );
  assert.equal(await again, "fresh");
});

it("reconnect: a dropped socket redials with a fresh ticket and answers again", async () => {
  const { stub, a } = await bootLinked(trackTest);
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
  assert.equal(await a.connection.askConnectInfo("B", "back", ASK_MS), "back");
});

it("blocked: 4102 revoked blocks with no redial, 4103 superseded blocks with its own message", async () => {
  const stub = await startStubHub(trackTest);
  const a = await bootDevice(stub, "A", {}, trackTest);
  stub.dropSocket("A", CLOSE_DEVICE_REVOKED, "device revoked");
  await waitFor(
    () => a.connection.status().socket.phase === "blocked",
    "the blocked phase",
  );
  const minted = a.mints();
  // Longer than the first backoff rung: a redial would have minted
  // by now.
  await delay(1_300);
  const revoked = a.connection.status().socket;
  assert.equal(revoked.phase, "blocked");
  assert.equal(a.mints(), minted, "a blocked supervisor redialed");
  assert.match(revoked.message, /removed from the account/);
  // A fresh device for the superseded arm, booted inside the tracked
  // scope so a failure here still closes the stub.
  const c = await bootDevice(stub, "C", {}, trackTest);
  stub.dropSocket("C", CLOSE_SUPERSEDED, "superseded");
  await waitFor(
    () => c.connection.status().socket.phase === "blocked",
    "the superseded block",
  );
  const superseded = c.connection.status().socket;
  assert.equal(superseded.phase, "blocked");
  assert.match(superseded.message, /another instance/);
});

it("liveness: a device heartbeats the device hub, and a hub that stops answering (or never answered) is declared dead and redialed with a fresh ticket", async () => {
  const stub = await startStubHub(trackTest);
  const heartbeat = { intervalMs: 30, timeoutMs: 120 };
  const a = await bootDevice(stub, "A", { heartbeat }, trackTest);
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
  const b = await bootDevice(stub, "B", { heartbeat }, trackTest);
  await waitFor(
    () => b.mints() >= 2,
    "B to redial a hub that never answered",
    3_000,
  );
  stub.setAnswerPings(true);
});

it("malformed inbound: garbage frames are dropped without killing the process", async () => {
  const { stub, a } = await bootLinked(trackTest);
  // Non-JSON text, an unparseable envelope, and a valid envelope
  // whose frame is neither the ask nor the answer.
  // All must be dropped, not fatal.
  stub.injectTo("A", "this is not json at all");
  stub.injectTo("A", JSON.stringify({ t: "totally-unknown" }));
  stub.injectTo("A", { t: "relay", from: "B", frame: "answer:1:bogus" });
  stub.injectTo("A", { t: "relay", from: "B", frame: "neither" });
  await delay(150);
  // The link is still live: a real ask still works.
  assert.equal(
    await a.connection.askConnectInfo("B", "alive", ASK_MS),
    "alive",
  );
});
