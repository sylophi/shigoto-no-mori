// The hub link: the one socket a device holds to its account's Durable
// Object carries presence, plus exactly ONE question between peers: the
// direct dialer's "how do I dial you?" (connectInfo). Contract data,
// broadcasts and pushes never ride this wire. They belong to the direct
// sockets the answer brokers (shared/hub/directDial.ts).
//
// The question is a single ask/answer pair keyed by an id, riding the
// hub's relay envelope as its opaque `frame`:
//
//   ask:    { ask, id, input? }
//   answer: { answer, id, ok: true, result? }
//         | { answer, id, ok: false, message, code? }
//
// There is no session: no handshake before the ask, nothing to close
// after the answer, so a dial costs one round trip. An undefined input
// or result rides as an absent field, the same framing invariant as
// the direct wire (frames.ts). There is no version negotiation either:
// a peer speaking another shape of this wire parses as nothing, its
// asks are dropped and ours to it time out, which the keeper retries
// on its ladder like any other unreachable peer.
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
  decodeEnvelope,
  encodeEnvelope,
  MAX_HUB_MESSAGE_BYTES,
  hubTextWithinLimit,
  ServerEnvelopeSchema,
  utf8ByteLength,
} from "./protocol";

// The one ask this wire serves.
export const CONNECT_INFO_ASK = "connectInfo";

// The code on an answer from a device that serves no direct listener
// (the web client, by construction). A structural fact about that
// device, not a failed call, so the dialer parks instead of retrying.
export const NO_LISTENER_CODE = "no-listener";

// Bounded like every string a hostile hub could inflate.
const AskNameSchema = z.string().max(64);

const AskFrameSchema = z.object({
  ask: AskNameSchema,
  id: z.number().int(),
  input: z.unknown().optional(),
});
type AskFrame = z.infer<typeof AskFrameSchema>;

const AnswerFrameSchema = z.discriminatedUnion("ok", [
  z.object({
    answer: AskNameSchema,
    id: z.number().int(),
    ok: z.literal(true),
    result: z.unknown().optional(),
  }),
  z.object({
    answer: AskNameSchema,
    id: z.number().int(),
    ok: z.literal(false),
    message: z.string(),
    code: z.string().max(64).optional(),
  }),
]);
type AnswerFrame = z.infer<typeof AnswerFrameSchema>;

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

function refusal(frame: AskFrame, message: string, code?: string): AnswerFrame {
  return {
    answer: frame.ask,
    id: frame.id,
    ok: false,
    message,
    ...(code === undefined ? {} : { code }),
  };
}

export function createHubLink(deps: HubLinkDeps): HubLink {
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

  function answerFor(from: string, frame: AskFrame): AnswerFrame {
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
      return { answer: frame.ask, id: frame.id, ok: true, result };
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
        input,
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
    if (frame.ok) {
      entry.resolve(frame.result);
    } else {
      entry.reject(new HubAskRefusedError(frame.message, frame.code));
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
