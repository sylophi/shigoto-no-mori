// The hub link: the one socket a device holds to its account's Durable
// Object carries presence, plus exactly ONE question between peers: the
// direct dialer's "how do I dial you?" (connectInfo). Contract data,
// broadcasts and pushes never ride this wire. They belong to the direct
// sockets the answer brokers (shared/hub/directDial.ts).
//
// The question is a single ask/answer pair keyed by an id, riding the
// hub's relay envelope as its opaque `frame`:
//
//   ask:    { ask, id, v, input? }
//   answer: { answer, id, v, ok: true, result? }
//         | { answer, id, v, ok: false, message, code? }
//
// `v` is the sender's app version on both, which is how the version
// floor holds on both ends: the answering side refuses an ask from a
// build below MIN_PEER_APP_VERSION, and the asking side refuses an
// answer from one. There is no session: no handshake before the ask,
// nothing to close after the answer, so a dial costs one round trip.
// An undefined input or result rides as an absent field, the same
// framing invariant as the direct wire (frames.ts).
//
// TRUST MODEL (see also protocol.ts): the device hub is our own managed
// service. Enrollment is Clerk-verified and every deliverable peer is
// by construction a device of the same account, so an ask carries no
// credential. The one serving rule is that an ask is answered only for
// a sender in the latest presence roster, which keeps a misrouted
// `from` from minting tickets. The size guard is a sanity bound.
//
// Pure on purpose: zod, the shared frame and envelope schemas, and an
// injected send function. No node builtins, no ws, no electron, so the
// hub-link check drives it headlessly and main wraps it around a
// real socket.
import { z } from "zod";
import { errorMessageOf } from "@shared/errors";
import {
  noHandlerMessage,
  resError,
  type ServerFrame,
} from "@shared/ipc/socket/frames";
import {
  decodeEnvelope,
  encodeEnvelope,
  MAX_HUB_MESSAGE_BYTES,
  hubTextWithinLimit,
  ServerEnvelopeSchema,
  utf8ByteLength,
} from "./protocol";

// The one ask this wire serves.
export const CONNECT_INFO_ASK = "connectInfo";

// The oldest app version this build asks or answers: the first release
// that speaks the ask (v2.9.0 and older speak the session protocol
// this replaced). Raising it is how a future release drops a wire it
// can no longer speak: both ends read it (see the header), so an older
// peer gets a PeerVersionError telling its user to update instead of a
// hang.
export const MIN_PEER_APP_VERSION = "2.10.0";

// The code on an answer refusing the asker's version. The asker turns
// it into a PeerVersionError carrying the answer's message.
export const VERSION_REFUSED_CODE = "version-refused";

// The code on an answer from a device that serves no direct listener
// (the web client, by construction). A structural fact about that
// device, not a failed call, so the dialer parks instead of retrying.
export const NO_LISTENER_CODE = "no-listener";

// Whether a peer's reported app version is at or above the floor.
// Only a release number is judged: a from-source build reports "dev",
// "0.0.0" (the desktop's placeholder), or "unknown" (a web build
// without its tag), and is current by construction.
function releaseParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? null : match.slice(1).map(Number);
}
const FLOOR_PARTS = releaseParts(MIN_PEER_APP_VERSION) ?? [0, 0, 0];
export function meetsVersionFloor(version: string): boolean {
  const parts = releaseParts(version);
  if (parts === null || parts[0] === 0) return true;
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== FLOOR_PARTS[i]) return parts[i] > FLOOR_PARTS[i];
  }
  return true;
}

// Bounded like every string a hostile hub could inflate.
const VersionSchema = z.string().max(64);
const AskNameSchema = z.string().max(64);

const AskFrameSchema = z.object({
  ask: AskNameSchema,
  id: z.number().int(),
  v: VersionSchema,
  input: z.unknown().optional(),
});
type AskFrame = z.infer<typeof AskFrameSchema>;

const AnswerFrameSchema = z.discriminatedUnion("ok", [
  z.object({
    answer: AskNameSchema,
    id: z.number().int(),
    v: VersionSchema,
    ok: z.literal(true),
    result: z.unknown().optional(),
  }),
  z.object({
    answer: AskNameSchema,
    id: z.number().int(),
    v: VersionSchema,
    ok: z.literal(false),
    message: z.string(),
    code: z.string().max(64).optional(),
  }),
]);
type AnswerFrame = z.infer<typeof AnswerFrameSchema>;

// What every build before the ask spoke on this wire: sm frames wrapped
// with a session epoch, opened by a hello. Parsed only so such a peer
// is told to update rather than left to hang, in both directions:
//
//   - every ask carries a pre-ask hello in the same fields (`epoch`,
//     `sm`, see askConnectInfo), so a pre-ask peer answers our ask with
//     a welcome at once, and any frame of this shape from a peer we are
//     asking fails that ask with a PeerVersionError.
//   - a pre-ask dialer's hello gets a welcome, and its connectInfo req
//     an error telling its user to update (or, from a device serving
//     no listener, the no-handler answer that dialer already parks on).
const LegacyFrameSchema = z.object({
  epoch: z.number().int(),
  sm: z.object({
    t: z.string().max(32),
    appVersion: VersionSchema.optional(),
    id: z.number().int().optional(),
    channel: z.string().max(256).optional(),
  }),
});
type LegacyFrame = z.infer<typeof LegacyFrameSchema>;

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

// The peer answered ok:false. The message is the peer's own text, so
// the shared/errors.ts matchers read it as they would any remote
// failure, and `code` classifies the refusals a caller acts on.
export class HubAskRefusedError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "HubAskRefusedError";
    this.code = code;
  }
}

// One side of the pair runs a version the other no longer speaks to.
// Terminal until that device updates (the keeper parks on it), and the
// message names which device needs the update.
export class PeerVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerVersionError";
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
  localAppVersion: string;
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
  // The socket is gone: every pending ask rejects.
  teardown(): void;
};

type PendingAsk = {
  deviceId: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Attacker-controlled ids are truncated in log lines so a hostile hub
// cannot flood the log with a huge forged `from`.
function truncateId(id: string): string {
  return id.length > 64 ? `${id.slice(0, 64)}...` : id;
}

export function createHubLink(deps: HubLinkDeps): HubLink {
  const local = deps.localAppVersion;
  const pending = new Map<number, PendingAsk>();
  // Unique per link across every peer, so an answer is matched by id
  // alone and then checked against the device it was asked of.
  let nextId = 1;
  let online = new Set<string>();
  let closed = false;
  let droppedInbound = 0;

  // Throttled warn for the dropped inbound paths (unparseable frames,
  // off-roster senders), so a flood cannot spam the log. Takes a thunk
  // so the message is only built on the one drop in fifty that logs.
  function warnDrop(message: () => string): void {
    droppedInbound += 1;
    if (droppedInbound % 50 === 1) {
      console.warn(
        `[hub] ${message()} (dropped ${droppedInbound} inbound so far)`,
      );
    }
  }

  function tooOldMessage(
    deviceId: string,
    version: string | undefined,
  ): string {
    const runs = version === undefined ? "an older version" : version;
    return `peer ${deviceId} runs Shigoto no Mori ${runs}, which this version (${local}) no longer connects to: update that device`;
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
    frame: object,
  ): { text: string; fits: boolean } {
    const text = encodeEnvelope({ t: "relay", to, frame });
    return { text, fits: hubTextWithinLimit(text, routingDelta(to)) };
  }

  // The send path for answers nobody here awaits. A failure is logged,
  // not thrown: the asker times out or sees the disconnect.
  function sendAnswerText(to: string, text: string): void {
    try {
      deps.send(text);
    } catch (error) {
      console.warn(
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

  function refusal(
    frame: AskFrame,
    message: string,
    code?: string,
  ): AnswerFrame {
    return {
      answer: frame.ask,
      id: frame.id,
      v: local,
      ok: false,
      message,
      ...(code === undefined ? {} : { code }),
    };
  }

  function answerFor(from: string, frame: AskFrame): AnswerFrame {
    if (!meetsVersionFloor(frame.v)) {
      return refusal(
        frame,
        `this device runs Shigoto no Mori ${frame.v}, and peer ${deps.localDeviceId} (${local}) accepts ${MIN_PEER_APP_VERSION} or newer: update this device`,
        VERSION_REFUSED_CODE,
      );
    }
    if (frame.ask !== CONNECT_INFO_ASK) {
      return refusal(frame, `unknown ask "${frame.ask}"`);
    }
    if (deps.serveConnectInfo === undefined) {
      return refusal(
        frame,
        `peer ${deps.localDeviceId} serves no direct listener`,
        NO_LISTENER_CODE,
      );
    }
    try {
      const result = deps.serveConnectInfo(from, frame.input);
      return { answer: frame.ask, id: frame.id, v: local, ok: true, result };
    } catch (error) {
      // Message text only, what survives Electron's IPC error
      // serialization too, so shared/errors.ts matchers behave the
      // same on every wire.
      return refusal(frame, errorMessageOf(error));
    }
  }

  function handleAsk(from: string, frame: AskFrame): void {
    // The DO always names real peers in presence, and a real peer must
    // be online to reach us, so an off-roster `from` is misrouted or
    // forged and gets nothing, not even a refusal.
    if (!online.has(from)) {
      warnDrop(() => `dropping ask from off-roster peer ${truncateId(from)}`);
      return;
    }
    const answer = answerFor(from, frame);
    const encoded = encodeFor(from, answer);
    if (encoded.fits) {
      sendAnswerText(from, encoded.text);
      return;
    }
    // An oversize result would be nacked and leave the asker waiting
    // out its timeout, so it becomes a refusal the asker rejects on at
    // once. A refusal is tiny and always fits.
    sendAnswerText(
      from,
      encodeFor(from, refusal(frame, "answer too large for the device hub"))
        .text,
    );
  }

  // ---- Asking ----

  function askConnectInfo(
    deviceId: string,
    input: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (closed) return Promise.reject(new HubLinkDownError());
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, {
        deviceId,
        resolve,
        reject,
        timer: setTimeout(() => {
          takePending(id)?.reject(new HubAskTimeoutError(deviceId, timeoutMs));
        }, timeoutMs),
      });
      const { text, fits } = encodeFor(deviceId, {
        ask: CONNECT_INFO_ASK,
        id,
        v: local,
        input,
        // The pre-ask hello (see LegacyFrameSchema): a build before
        // the ask ignores the fields above and welcomes this at once,
        // which fails the ask fast instead of waiting out the timeout.
        epoch: 0,
        sm: { t: "hello", deviceId: deps.localDeviceId, appVersion: local },
      });
      try {
        if (!fits) throw new HubMessageTooLargeError();
        deps.send(text);
      } catch (error) {
        takePending(id)?.reject(error);
      }
    });
  }

  function handleAnswer(from: string, frame: AnswerFrame): void {
    const entry = pending.get(frame.id);
    // A late answer (the ask already timed out) or one from a device
    // other than the one asked: nothing to route it to.
    if (entry === undefined || entry.deviceId !== from) return;
    takePending(frame.id);
    if (!meetsVersionFloor(frame.v)) {
      entry.reject(new PeerVersionError(tooOldMessage(from, frame.v)));
    } else if (frame.ok) {
      entry.resolve(frame.result);
    } else if (frame.code === VERSION_REFUSED_CODE) {
      entry.reject(new PeerVersionError(frame.message));
    } else {
      entry.reject(new HubAskRefusedError(frame.message, frame.code));
    }
  }

  // ---- Pre-ask peers ----

  function sendLegacy(to: string, epoch: number, sm: ServerFrame): void {
    const { text, fits } = encodeFor(to, { epoch, sm });
    if (fits) sendAnswerText(to, text);
  }

  function handleLegacy(from: string, { epoch, sm }: LegacyFrame): void {
    rejectAsksTo(
      from,
      () => new PeerVersionError(tooOldMessage(from, sm.appVersion)),
    );
    if (!online.has(from)) return;
    if (sm.t === "hello") {
      sendLegacy(from, epoch, {
        t: "welcome",
        deviceId: deps.localDeviceId,
        appVersion: local,
      });
    } else if (sm.t === "req" && sm.id !== undefined) {
      sendLegacy(
        from,
        epoch,
        resError(
          sm.id,
          deps.serveConnectInfo === undefined
            ? noHandlerMessage(sm.channel ?? "")
            : `peer ${deps.localDeviceId} runs Shigoto no Mori ${local}, which no longer connects to this version: update this device`,
        ),
      );
    }
  }

  // ---- Envelope routing ----

  function applyPresence(list: readonly string[]): void {
    online = new Set(list);
    for (const [id, entry] of pending) {
      if (!online.has(entry.deviceId)) {
        takePending(id)?.reject(new HubPeerOfflineError(entry.deviceId));
      }
    }
    notifyPresence([...list]);
  }

  // The presence notice, with the callback's own failure logged rather
  // than let loose in the link.
  function notifyPresence(list: string[]): void {
    if (deps.onPresence === undefined) return;
    try {
      deps.onPresence(list);
    } catch (error) {
      console.warn(`[hub] onPresence threw: ${errorMessageOf(error)}`);
    }
  }

  function handleFrame(from: string, frame: unknown): void {
    const ask = AskFrameSchema.safeParse(frame);
    if (ask.success) {
      handleAsk(from, ask.data);
      return;
    }
    const answer = AnswerFrameSchema.safeParse(frame);
    if (answer.success) {
      handleAnswer(from, answer.data);
      return;
    }
    const legacy = LegacyFrameSchema.safeParse(frame);
    if (legacy.success) {
      handleLegacy(from, legacy.data);
      return;
    }
    warnDrop(() => `dropping unparseable frame from ${truncateId(from)}`);
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
      return [...online].toSorted();
    },

    teardown(): void {
      closed = true;
      for (const id of pending.keys()) {
        takePending(id)?.reject(new HubLinkDownError());
      }
      if (online.size > 0) {
        online = new Set();
        notifyPresence([]);
      }
    },
  };
}
