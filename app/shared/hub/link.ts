// The hub link: the one socket a device holds to its account's Durable
// Object carries presence, plus exactly ONE question between peers: the
// direct dialer's "how do I dial you?" (connectInfo). Contract data,
// broadcasts and pushes never ride this wire. They belong to the direct
// sockets the answer brokers (shared/hub/directDial.ts).
//
// The question is a single ask/answer pair keyed by an id, riding the
// hub's relay envelope as its opaque `frame` (RelayFrame in
// packages/contracts/src/hubProtocol.ts), sealed as one Noise IK
// handshake (shared/crypto/noise.ts): the ask is its first message,
// sealed to the key the roster names for the device asked, and the
// answer its second, which only the asker can read. The hub sees the
// two device ids and the ask's id, nothing else.
//
// There is no session: each ask is a handshake of its own, nothing is
// kept after the answer, so a dial costs one round trip. An undefined input
// or result rides as an absent field, the same framing invariant as
// the direct wire (frames.ts). There is no version negotiation either:
// a peer speaking another shape of this wire parses as nothing, its
// asks are dropped and ours to it time out, which the keeper retries
// on its ladder like any other unreachable peer.
//
// TRUST MODEL (see also hubProtocol.ts): the device hub is our own
// managed service and the roster of every device's key. An ask is
// answered only for a sender in the latest presence roster whose
// handshake proves the key the roster names for it, so neither a
// misrouted `from` nor a party in the middle mints tickets. The size
// guard is a sanity bound.
//
// Pure on purpose: the shared frame and envelope schemas and an
// injected send function. No node builtins, no ws, no electron, so the
// hub-link check drives it headlessly and main wraps it around a
// real socket.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  type AnswerPayload,
  AnswerPayloadSchema,
  type AskPayload,
  AskPayloadSchema,
  decodeEnvelope,
  decodeRelayFrame,
  encodeEnvelope,
  encodeRelayFrame,
  MAX_HUB_MESSAGE_BYTES,
  hubTextWithinLimit,
  type OnlineDevice,
  type RelayFrame,
  ServerEnvelopeSchema,
  utf8ByteLength,
} from "@shigomori/contracts/hubProtocol";
import { fromBase64Url, sameKey, toBase64Url } from "@shared/crypto/deviceKey";
import { HandshakeState, type KeyPair } from "@shared/crypto/noise";
import { log } from "@shared/log";

// The one ask this wire serves.
export const CONNECT_INFO_ASK = "connectInfo";

// The code on an answer from a device that serves no direct listener
// (the web client, by construction). A structural fact about that
// device, not a failed call, so the dialer parks instead of retrying.
export const NO_LISTENER_CODE = "no-listener";

const decodeAsk = Schema.decodeUnknownOption(
  Schema.fromJsonString(AskPayloadSchema),
);
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(AnswerPayloadSchema),
);

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// What both sides of one ask mix into its handshake, so a sealed ask
// relayed to any other device, or the other way round, does not read.
export function relayPrologue(askerId: string, askedId: string): Uint8Array {
  return utf8Encoder.encode(`sm-relay-v1:${askerId}>${askedId}`);
}

// IK's second message: the responder's ephemeral key, then the payload
// and its tag.
const ANSWER_OVERHEAD_BYTES = 32 + 16;

// How long an ask is good for, past any timeout an asker waits it out
// with, and how far two devices' clocks may disagree.
const ASK_LIFETIME_MS = 60_000;
const CLOCK_SKEW_MS = 120_000;

// The asks a device has read, by their handshake hash, each until it
// expires: what turns a replayed ask away. Kept by the hub connection,
// so it outlives the link a socket redial replaces. Bounded: while it is
// full, a new ask is refused until an entry expires, since forgetting
// one that has not would let it be replayed.
export const MAX_SEEN_ASKS = 4096;

export type SeenAsks = Map<string, number>;

// Whether an ask with this hash and expiry is one to answer, noting it
// if so.
export function freshAsk(
  seen: SeenAsks,
  hash: string,
  expiresAt: number,
  now: number,
): boolean {
  for (const [key, until] of seen) {
    if (until < now) seen.delete(key);
  }
  if (
    seen.has(hash) ||
    expiresAt < now - CLOCK_SKEW_MS ||
    expiresAt > now + ASK_LIFETIME_MS + CLOCK_SKEW_MS
  ) {
    return false;
  }
  if (seen.size >= MAX_SEEN_ASKS) return false;
  seen.set(hash, expiresAt + CLOCK_SKEW_MS);
  return true;
}

// The addressed peer has no socket on the device hub (an offline nack,
// or a presence list it vanished from). A pending ask to it rejects
// with this so a caller sees "that device is offline" distinctly from a
// refusal.
export class HubPeerOfflineError extends Error {
  constructor(deviceId: string) {
    super(`hub peer is offline (device ${deviceId})`);
    this.name = "HubPeerOfflineError";
  }
}

// An outbound envelope would exceed the device hub's message limit. The
// guard runs BEFORE the frame touches the wire, measuring the same
// deliver shape the DO measures. A legitimate ask fits with room to
// spare, so oversize is a hard error surfaced to the caller instead of
// a round trip ending in a nack.
export class HubMessageTooLargeError extends Error {
  constructor() {
    super(`hub message exceeds the ${MAX_HUB_MESSAGE_BYTES} byte limit`);
    this.name = "HubMessageTooLargeError";
  }
}

// The hub socket itself is gone (torn down, or never up), so callers
// can tell "my own hub socket is down" from "the peer is offline".
export class HubLinkDownError extends Error {
  constructor() {
    super("hub connection is down");
    this.name = "HubLinkDownError";
  }
}

// The peer never answered within the ask's budget.
export class HubAskTimeoutError extends Error {
  constructor(deviceId: string, timeoutMs: number) {
    super(`hub peer ${deviceId} did not answer within ${timeoutMs}ms`);
    this.name = "HubAskTimeoutError";
  }
}

// The peer answered ok:false. The message is the peer's own text, and
// `code` classifies the refusals a caller acts on.
export class HubAskRefusedError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "HubAskRefusedError";
    this.code = code;
  }
}

// The connectInfo server: answers one ask synchronously from the
// authenticated caller (the DO stamps `from`, and the roster gate has
// already bounded it to a present device) and the raw input, which it
// parses itself. Throwing answers ok:false with the message. Supplied
// by the composition so the link never imports a contract, and absent
// where the device serves no direct listener (the web client).
export type ServeConnectInfo = (
  callerDeviceId: string,
  input: unknown,
) => unknown;

type HubLinkDeps = {
  localDeviceId: string;
  // This device's static key pair, the one it enrolled with.
  localKey: KeyPair;
  // The asks this device has read (SeenAsks above).
  seenAsks: SeenAsks;
  // Writes one text message to the raw hub socket. May throw when the
  // socket is unusable, and the caller of the failed operation sees it.
  send(text: string): void;
  serveConnectInfo?: ServeConnectInfo;
  // The full online list from every presence envelope, after the link
  // has failed the pending asks to devices that left it.
  onPresence?: (online: readonly string[]) => void;
};

export type HubLink = {
  // Feed one raw text message from the hub socket through the link.
  handleMessage(text: string): void;
  // Ask one peer for its connect info. Resolves the peer's raw result
  // (the dialer parses it against the contract schema) or rejects with
  // one of the typed errors above, within timeoutMs at the latest.
  askConnectInfo(
    deviceId: string,
    input: unknown,
    timeoutMs: number,
  ): Promise<unknown>;
  onlineDeviceIds(): readonly string[];
  // The key the latest roster names for an online device.
  publicKeyOf(deviceId: string): Uint8Array | undefined;
  // The socket is gone: every pending ask rejects.
  teardown(): void;
};

type PendingAsk = {
  deviceId: string;
  // The handshake the ask opened, which reads the answer.
  handshake: HandshakeState;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Attacker-controlled ids are truncated in log lines so a hostile hub
// cannot flood the log with a huge forged `from`.
function truncateId(id: string): string {
  return id.length > 64 ? `${id.slice(0, 64)}...` : id;
}

function refusal(message: string, code?: string): AnswerPayload {
  return { ok: false, message, ...(code === undefined ? {} : { code }) };
}

export function createHubLink(deps: HubLinkDeps): HubLink {
  const pending = new Map<number, PendingAsk>();
  // Unique per link across every peer, so an answer is matched by id
  // alone and then checked against the device it was asked of. It
  // starts at random because an answer reaches every tab of a web
  // device, and a sibling tab's ask must not share its id.
  let nextId = Math.floor(Math.random() * 2 ** 40);
  // The latest roster: each online device and its public key.
  let online = new Map<string, Uint8Array>();
  let closed = false;
  let droppedInbound = 0;

  // Throttled warn for the dropped inbound paths (unparseable frames,
  // off-roster senders), so a flood cannot spam the log. Takes a thunk
  // so the message is only built on the one drop in fifty that logs.
  function warnDrop(message: () => string): void {
    droppedInbound += 1;
    if (droppedInbound % 50 === 1) {
      log.warn(`[hub] ${message()} (dropped ${droppedInbound} inbound so far)`);
    }
  }

  // Deliver carries `"from":"<localId>"`, send carries `"to":"<to>"`.
  // The DO measures the deliver shape against the limit, so a send-shape
  // encode plus this delta measures exactly what the DO will.
  function routingDelta(to: string): number {
    return (
      utf8ByteLength(`"from":"${deps.localDeviceId}"`) -
      utf8ByteLength(`"to":"${to}"`)
    );
  }

  // Encode the send envelope once and report whether the DELIVER shape
  // fits the limit, so nothing stringifies twice.
  function encodeFor(
    to: string,
    frame: RelayFrame,
  ): { text: string; fits: boolean } {
    const text = encodeEnvelope({
      t: "relay",
      to,
      frame: encodeRelayFrame(frame),
    });
    return { text, fits: hubTextWithinLimit(text, routingDelta(to)) };
  }

  // Whether an answer of this many payload bytes, once sealed, fits the
  // limit: measured before sealing, since the handshake seals once.
  function answerFits(to: string, id: number, payloadBytes: number): boolean {
    const sealedBytes = ANSWER_OVERHEAD_BYTES + payloadBytes;
    const sealed = "x".repeat(Math.ceil((sealedBytes * 4) / 3));
    return encodeFor(to, { kind: "answer", id, sealed }).fits;
  }

  // The send path for answers nobody here awaits. A failure is logged,
  // not thrown: the asker times out or sees the disconnect.
  function sendAnswerText(to: string, text: string): void {
    try {
      deps.send(text);
    } catch (error) {
      log.warn(
        `[hub] failed to answer ${truncateId(to)}: ${errorMessageOf(error)}`,
      );
    }
  }

  function takePending(id: number): PendingAsk | undefined {
    const entry = pending.get(id);
    if (entry === undefined) return undefined;
    pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  // Map iteration tolerates deleting the entry being visited.
  function rejectAsksTo(deviceId: string, error: () => unknown): void {
    for (const [id, entry] of pending) {
      if (entry.deviceId === deviceId) takePending(id)?.reject(error());
    }
  }

  // ---- Answering ----

  function answerFor(from: string, ask: AskPayload): AnswerPayload {
    if (ask.ask !== CONNECT_INFO_ASK) {
      return refusal(`unknown ask "${ask.ask}"`);
    }
    if (deps.serveConnectInfo === undefined) {
      return refusal(
        `peer ${deps.localDeviceId} serves no direct listener`,
        NO_LISTENER_CODE,
      );
    }
    try {
      return { ok: true, result: deps.serveConnectInfo(from, ask.input) };
    } catch (error) {
      // The message only: connectInfo fails with no contract error.
      return refusal(errorMessageOf(error));
    }
  }

  function handleAsk(from: string, frame: RelayFrame): void {
    // The DO always names real peers in presence, and a real peer must
    // be online to reach us, so an off-roster `from` is misrouted or
    // forged and gets nothing, not even a refusal.
    const fromKey = online.get(from);
    if (fromKey === undefined) {
      warnDrop(() => `dropping ask from off-roster peer ${truncateId(from)}`);
      return;
    }
    // An ask that does not open, or opens under a key other than the one
    // the roster names for its sender, came from someone else.
    const handshake = new HandshakeState({
      initiator: false,
      prologue: relayPrologue(from, deps.localDeviceId),
      s: deps.localKey,
    });
    let ask: AskPayload;
    try {
      const opened = decodeAsk(
        utf8Decoder.decode(
          handshake.readMessage(fromBase64Url(frame.sealed)).payload,
        ),
      );
      if (
        Option.isNone(opened) ||
        !sameKey(handshake.remoteStaticKey(), fromKey)
      ) {
        throw new Error("not this peer's ask");
      }
      ask = opened.value;
    } catch {
      warnDrop(
        () => `dropping an ask that does not open from ${truncateId(from)}`,
      );
      return;
    }
    // A replayed ask opens like the original, so it is told apart by
    // its handshake, which no other ask shares, and its expiry.
    if (
      !freshAsk(
        deps.seenAsks,
        toBase64Url(handshake.handshakeHash()),
        ask.expiresAt,
        Date.now(),
      )
    ) {
      warnDrop(
        () => `dropping a replayed or expired ask from ${truncateId(from)}`,
      );
      return;
    }
    let payload = utf8Encoder.encode(JSON.stringify(answerFor(from, ask)));
    // An oversize result would be nacked and leave the asker waiting
    // out its timeout, so it becomes a refusal the asker rejects on at
    // once. A refusal is tiny and always fits.
    if (!answerFits(from, frame.id, payload.length)) {
      payload = utf8Encoder.encode(
        JSON.stringify(refusal("answer too large for the device hub")),
      );
    }
    const sealed = toBase64Url(handshake.writeMessage(payload).message);
    sendAnswerText(
      from,
      encodeFor(from, { kind: "answer", id: frame.id, sealed }).text,
    );
  }

  // ---- Asking ----

  function askConnectInfo(
    deviceId: string,
    input: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (closed) return Promise.reject(new HubLinkDownError());
    // Sealing needs the key the roster names, so a device off the
    // roster is offline as far as this link can tell.
    const deviceKey = online.get(deviceId);
    if (deviceKey === undefined) {
      return Promise.reject(new HubPeerOfflineError(deviceId));
    }
    const id = nextId++;
    const handshake = new HandshakeState({
      initiator: true,
      prologue: relayPrologue(deps.localDeviceId, deviceId),
      s: deps.localKey,
      rs: deviceKey,
    });
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, {
        deviceId,
        handshake,
        resolve,
        reject,
        timer: setTimeout(() => {
          takePending(id)?.reject(new HubAskTimeoutError(deviceId, timeoutMs));
        }, timeoutMs),
      });
      try {
        const ask: AskPayload = {
          ask: CONNECT_INFO_ASK,
          expiresAt: Date.now() + ASK_LIFETIME_MS,
          input,
        };
        const payload = utf8Encoder.encode(JSON.stringify(ask));
        // Sealed, it only grows, so an ask over the limit already is
        // refused before the handshake's own bound would be.
        if (payload.length > MAX_HUB_MESSAGE_BYTES) {
          throw new HubMessageTooLargeError();
        }
        const sealed = toBase64Url(handshake.writeMessage(payload).message);
        const { text, fits } = encodeFor(deviceId, { kind: "ask", id, sealed });
        if (!fits) throw new HubMessageTooLargeError();
        deps.send(text);
      } catch (error) {
        takePending(id)?.reject(error);
      }
    });
  }

  function handleAnswer(from: string, frame: RelayFrame): void {
    const entry = pending.get(frame.id);
    // A late answer (the ask already timed out), a replayed one, or one
    // from a device other than the one asked: nothing to route it to.
    if (entry === undefined || entry.deviceId !== from) return;
    takePending(frame.id);
    let answer: AnswerPayload;
    try {
      const opened = decodeAnswer(
        utf8Decoder.decode(
          entry.handshake.readMessage(fromBase64Url(frame.sealed)).payload,
        ),
      );
      if (Option.isNone(opened)) throw new Error("not an answer");
      answer = opened.value;
    } catch {
      // The ask's handshake is spent, so a genuine answer could not be
      // read after this one either.
      entry.reject(
        new HubAskRefusedError(
          `the answer from ${truncateId(from)} did not open`,
          undefined,
        ),
      );
      return;
    }
    if (answer.ok) {
      entry.resolve(answer.result);
    } else {
      entry.reject(new HubAskRefusedError(answer.message, answer.code));
    }
  }

  // ---- Envelope routing ----

  function applyPresence(roster: readonly OnlineDevice[]): void {
    const previous = online;
    online = new Map();
    for (const device of roster) {
      const key = fromBase64Url(device.publicKey);
      const before = previous.get(device.deviceId);
      // No pinning: the roster is the trust root, and a device that
      // enrolled again holds a new key. The change is only noted.
      if (before !== undefined && !sameKey(before, key)) {
        log.info(`[hub] device ${truncateId(device.deviceId)} has a new key`);
      }
      online.set(device.deviceId, key);
    }
    for (const [id, entry] of pending) {
      if (!online.has(entry.deviceId)) {
        takePending(id)?.reject(new HubPeerOfflineError(entry.deviceId));
      }
    }
    notifyPresence(roster.map((device) => device.deviceId));
  }

  // The presence notice, with the callback's own failure logged rather
  // than let loose in the link.
  function notifyPresence(list: string[]): void {
    if (deps.onPresence === undefined) return;
    try {
      deps.onPresence(list);
    } catch (error) {
      log.warn(`[hub] onPresence threw: ${errorMessageOf(error)}`);
    }
  }

  function handleFrame(from: string, text: string): void {
    const frame = decodeRelayFrame(text);
    if (frame === null) {
      warnDrop(() => `dropping unparseable frame from ${truncateId(from)}`);
    } else if (frame.kind === "ask") {
      handleAsk(from, frame);
    } else {
      handleAnswer(from, frame);
    }
  }

  return {
    handleMessage(text: string): void {
      const envelope = decodeEnvelope(text, ServerEnvelopeSchema);
      if (envelope === null) {
        // Malformed messages are dropped, never fatal, mirroring the
        // direct socket. One bad message must not kill live traffic.
        warnDrop(() => "dropping unparseable envelope");
        return;
      }
      if (envelope.t === "presence") {
        applyPresence(envelope.online);
      } else if (envelope.t === "nack") {
        // A nack names no ask, so it fails every ask pending to that
        // device. too-large should be unreachable: asks pre-measure
        // the exact deliver shape the DO does.
        const error =
          envelope.reason === "offline"
            ? () => new HubPeerOfflineError(envelope.to)
            : () => new HubMessageTooLargeError();
        rejectAsksTo(envelope.to, error);
      } else {
        handleFrame(envelope.from, envelope.frame);
      }
    },

    askConnectInfo,

    onlineDeviceIds(): readonly string[] {
      return [...online.keys()].toSorted();
    },

    publicKeyOf(deviceId: string): Uint8Array | undefined {
      return online.get(deviceId);
    },

    teardown(): void {
      closed = true;
      for (const id of pending.keys()) {
        takePending(id)?.reject(new HubLinkDownError());
      }
      if (online.size > 0) {
        online = new Map();
        notifyPresence([]);
      }
    },
  };
}
