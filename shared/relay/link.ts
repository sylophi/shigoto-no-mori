// The relay link: the multiplexing core of the relay transport (v2
// step 4, slice C). One device holds ONE socket to its account's
// Durable Object, and both roles share it. Since v2 step 10 slice C
// the relay is ORCHESTRATION ONLY: the HOST role serves exactly the
// broker surface (sm hello/req for direct:connectInfo, bye) and
// refuses every other channel, and the CLIENT role opens the
// short-lived sm-level peer sessions the direct dialer brokers
// through (shared/relay/directDial.ts). Contract data, broadcasts and
// pushes never ride this wire anymore. They belong to the direct
// sockets the broker hands out. Role discrimination is purely the
// inner sm frame's `t` field: hello, req and bye are requests TO us,
// welcome and res are replies FOR us. One decoder, one switch.
//
// TRUST MODEL (see also protocol.ts): the relay is our own managed
// service. Enrollment is Clerk-verified, the per-device credential is
// exchanged for short-lived connect tickets, so every deliverable peer
// is by construction a device of the same account, which is why the
// hello token is ignored here. There is no command surface to
// authorize here: the broker channel is a read by contract, and every
// mutating call rides the direct wire, where dispatch gates it on the
// host's per-peer command grant. The remaining defenses are sanity
// bounds, not armor: a per-session epoch stamped on every sm frame so
// a stale res from a prior peer pairing is never matched against a
// fresh one, a presence-roster gate on hello so a misrouted `from`
// cannot allocate a host session, and per-peer size and in-flight
// caps.
//
// Pure on purpose: zod, the shared frame and envelope schemas, and an
// injected send function. No node builtins, no ws, no electron, so the
// relay-link check drives it headlessly and main wraps it around a
// real socket.
import { z } from "zod";
import { errorMessageOf } from "@shared/errors";
import {
  type ClientFrame,
  ClientFrameSchema,
  HELLO_TIMEOUT_MS,
  type ReqFrame,
  type ServerFrame,
  ServerFrameSchema,
} from "@shared/ipc/socket/frames";
import {
  decodeEnvelope,
  encodeEnvelope,
  MAX_RELAY_MESSAGE_BYTES,
  relayTextWithinLimit,
  ServerEnvelopeSchema,
  utf8ByteLength,
} from "./protocol";

// The relay's own per-peer in-flight bound. Legitimate broker
// concurrency is ~1 (one connectInfo exchange per dial), so this is a
// small sanity cap, deliberately NOT the shared data-wire budget in
// frames.ts (the direct and LAN bindings keep 64 for long-polls and
// chunk streams). The in-flight count is tracked per deviceId and
// survives both a re-hello and a presence flap, so neither a peer
// re-helloing nor a flapping roster can reset the cap while old
// dispatches are still running.
export const MAX_RELAY_IN_FLIGHT_PER_PEER = 4;

// The inner frame union both roles decode from a delivered envelope.
const InnerFrameSchema = z.union([ClientFrameSchema, ServerFrameSchema]);

// Every sm frame the relay carries is wrapped with the session epoch.
// The wrapper lives in the relay layer only, so frames.ts and the LAN
// binding never learn about epochs. The DO forwards this whole object
// verbatim as the opaque `frame`, so the epoch survives the hop exactly
// as the sm frame does. The CLIENT owns the epoch: it mints a fresh one
// per connectBroker and sends it in hello, the HOST records it and echoes
// it on welcome and res, and the client drops any inbound frame whose
// epoch is not its current one. A redial mints a new epoch, so late
// frames from the prior pairing are dropped rather than mis-matched.
const RelayFrameSchema = z.object({
  epoch: z.number().int(),
  sm: InnerFrameSchema,
});
type RelayFrame = z.infer<typeof RelayFrameSchema>;

// The addressed peer has no socket on the relay (an offline nack, or a
// presence list it vanished from). In-flight calls to it reject with
// this so a caller sees "that device is offline" distinctly from a
// handler error.
export class RelayPeerOfflineError extends Error {
  constructor(deviceId: string) {
    super(`relay peer is offline (device ${deviceId})`);
    this.name = "RelayPeerOfflineError";
  }
}

// An outbound envelope would exceed the relay's message limit. The
// guard runs BEFORE the frame touches the wire, measuring the same
// deliver shape the DO measures. Every legitimate broker frame fits
// with room to spare, so oversize is a hard error surfaced to the
// caller instead of a round trip ending in a nack.
export class RelayMessageTooLargeError extends Error {
  constructor() {
    super(`relay message exceeds the ${MAX_RELAY_MESSAGE_BYTES} byte limit`);
    this.name = "RelayMessageTooLargeError";
  }
}

// The relay socket itself is gone (torn down, or never up). Peer calls
// reject with this so callers can distinguish "my own relay socket is
// down" from "the peer is offline".
export class RelayLinkDownError extends Error {
  constructor() {
    super("relay connection is down");
    this.name = "RelayLinkDownError";
  }
}

// The answer a wire gives when nothing serves the requested channel.
// Built through ONE function because both roles need it: the host role
// puts it on the res frame, and the client role recognizes it on
// arrival. A res carries a message and nothing else (a code field
// would be a wire change), so re-typing the answer here is what keeps
// every caller from pattern-matching a string it does not own.
function noHandlerMessage(channel: string): string {
  return `No handler registered for channel "${channel}"`;
}

// The peer answered "I serve no handler for that channel". STRUCTURAL,
// not transient: a refuse-all host (the web client, which supplies the
// broker channel with no handler by construction) answers this to
// every req and will answer it identically forever. The typed form is
// what lets the direct dialer tell it apart from a relay blip or a
// peer mid-boot, whose rejections are plain errors worth retrying.
export class RelayNoHandlerError extends Error {
  readonly channel: string;
  constructor(channel: string) {
    super(noHandlerMessage(channel));
    this.name = "RelayNoHandlerError";
    this.channel = channel;
  }
}

// The context a broker dispatch runs under: the authenticated caller
// and the session's abort signal, nothing more. Deliberately NOT the
// full HandlerContext: the relay carries no pushes, so a notifier sink
// would be a lie, and its absence keeps the broker slot's type honest
// about what this wire can do.
export type RelayBrokerContext = {
  // The authenticated peer identity: the DO consumed this peer's
  // connect ticket and stamps `from`, and the roster gate in
  // handleHello already bounded it to a real account device.
  callerDeviceId: string;
  // Aborts when this peer's session dies (re-hello, presence drop,
  // bye, link teardown).
  signal: AbortSignal;
};

// What the client role resolves: the broker leg's whole surface. One
// typed invoke pinned to the broker channel plus close, so contract
// traffic structurally cannot ride the relay from this side either.
// The identity fields are informational facts of the handshake (the
// dialed deviceId and the welcome's appVersion), not a data path.
export type RelayBrokerSession = {
  // Sends one req on the broker channel and resolves its res. Input
  // and result are both unknown at this layer: the dialer owns the
  // contract types on either end (it builds the input and parses the
  // answer against the contract schema), so the link stays a plain
  // frames-plus-zod core.
  brokerInvoke(input: unknown): Promise<unknown>;
  close(): void;
  remoteDeviceId: string;
  remoteAppVersion: string;
};

// The ONE channel-plus-handler pair the relay wire serves, injected by
// the composition (main/ipc/register.ts, the web bridge) so the link
// core never imports a contract. The channel is needed by BOTH roles
// (the host role's dispatch gate and the client role's req frames).
// The handler is absent on client-only platforms (the web), where
// every req is answered with the no-handler shape -- which the dialing
// side receives as the typed RelayNoHandlerError, because "this peer
// serves nobody" is permanent and must not be retried like a blip.
// There is no handler map to mount anything else on, so a data path
// through the relay is a type error, not a discouraged registration.
export type RelayBroker = {
  channel: string;
  handler?: (ctx: RelayBrokerContext, raw: unknown) => Promise<unknown>;
};

export type RelayLinkDeps = {
  localDeviceId: string;
  localAppVersion: string;
  // Writes one text message to the raw relay socket. May throw when the
  // socket is unusable, and the caller of the failed operation sees it.
  send(text: string): void;
  // The one broker slot this wire serves (see RelayBroker).
  broker: RelayBroker;
  // The full online list from every presence envelope, after the link
  // has reconciled its per-peer state against it.
  onPresence?: (online: readonly string[]) => void;
};

export type RelayLink = {
  // Feed one raw text message from the relay socket through the link.
  handleMessage(text: string): void;
  // CLIENT role: open the short-lived broker session to a peer device.
  // Sends hello, awaits welcome, then brokerInvoke correlates req/res
  // by id. The sole real caller is the direct dialer's broker leg.
  connectBroker(deviceId: string): Promise<RelayBrokerSession>;
  onlineDeviceIds(): readonly string[];
  // The socket is gone: every peer's state dies, in-flight calls
  // reject, and host sessions abort.
  teardown(): void;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type ClientPeer = {
  deviceId: string;
  // This pairing's epoch, minted at connectBroker. Stamped on every
  // outbound frame and checked against every inbound one.
  epoch: number;
  nextId: number;
  pending: Map<number, PendingCall>;
  // Non-null once the peer's welcome landed. remoteAppVersion is
  // informational; the peer identity is the DIALED deviceId, never the
  // welcome's self-asserted one (M5).
  welcome: { remoteAppVersion: string } | null;
  helloWaiter: {
    resolve: (session: RelayBrokerSession) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  invoke: (input: unknown) => Promise<unknown>;
  closed: boolean;
};

type HostSession = {
  // The epoch recorded from this peer's most recent hello, echoed on
  // every welcome and res so the peer can drop a stale one.
  epoch: number;
  controller: AbortController;
  ctx: RelayBrokerContext;
};

function rejectAllPending(peer: ClientPeer, error: unknown): void {
  for (const entry of peer.pending.values()) entry.reject(error);
  peer.pending.clear();
}

// Attacker-controlled ids are truncated in log lines so a hostile relay
// cannot flood the log with a huge forged `from`.
function truncateId(id: string): string {
  return id.length > 64 ? `${id.slice(0, 64)}...` : id;
}

export function createRelayLink(deps: RelayLinkDeps): RelayLink {
  const clientPeers = new Map<string, ClientPeer>();
  const hostSessions = new Map<string, HostSession>();
  // In-flight dispatch count per peer deviceId, kept OUTSIDE the session
  // so neither a re-hello (which swaps the session) nor a presence flap
  // (which drops it) can reset the cap while old dispatches are still
  // running. Only handleReq mutates it: +1 when a dispatch is admitted,
  // -1 in that dispatch's finally, which is also the sole site that
  // deletes the key (when it reaches zero).
  const hostInFlight = new Map<string, number>();
  let online = new Set<string>();
  // A fresh epoch per connectBroker. A monotonic integer is enough: it
  // only needs to differ from the pairing it replaces.
  let nextEpoch = 1;
  let droppedInbound = 0;

  // Throttled warn for the dropped inbound paths (unparseable frames,
  // off-roster peers), so a flood cannot spam the log the way an
  // unthrottled warn per drop would. Takes a thunk so the message text
  // (and any id truncation inside it) is only built on the one drop in
  // fifty that actually logs, never on the hot drop path.
  function warnDrop(message: () => string): void {
    droppedInbound += 1;
    if (droppedInbound % 50 === 1) {
      console.warn(
        `[relay] ${message()} (dropped ${droppedInbound} inbound so far)`,
      );
    }
  }

  // Deliver carries `"from":"<localId>"`, send carries `"to":"<to>"`.
  // The DO measures the deliver shape against the limit, so a send-shape
  // encode plus this delta measures exactly what the DO will (Q7).
  function routingDelta(to: string): number {
    return (
      utf8ByteLength(`"from":"${deps.localDeviceId}"`) -
      utf8ByteLength(`"to":"${to}"`)
    );
  }

  // Encode the wire (send) envelope once and report whether the DELIVER
  // shape fits the limit, so the hot path never stringifies twice.
  function relayFrameTexts(
    to: string,
    frame: ClientFrame | ServerFrame,
    epoch: number,
  ): { sendText: string; fits: boolean } {
    const relayFrame: RelayFrame = { epoch, sm: frame };
    const sendText = encodeEnvelope({ t: "relay", to, frame: relayFrame });
    return { sendText, fits: relayTextWithinLimit(sendText, routingDelta(to)) };
  }

  // The one outbound path for sm frames. Oversize is a hard local
  // error, never a wire round trip. Every legitimate broker frame is
  // small, so tripping this means a caller aimed bulk data at the
  // orchestration wire.
  function sendFrameToPeer(
    to: string,
    frame: ClientFrame | ServerFrame,
    epoch: number,
  ): void {
    const { sendText, fits } = relayFrameTexts(to, frame, epoch);
    if (!fits) throw new RelayMessageTooLargeError();
    deps.send(sendText);
  }

  // The one send path for pre-encoded answers a caller is awaiting
  // (welcome, res). A send failure here is logged, not thrown: the
  // peer's side times out or sees the disconnect, exactly as it would
  // on a dead LAN socket.
  function sendAnswerText(to: string, text: string): void {
    try {
      deps.send(text);
    } catch (error) {
      console.warn(
        `[relay] failed to answer ${truncateId(to)}: ${errorMessageOf(error)}`,
      );
    }
  }

  // The frame form of sendAnswerText. Everything answered through here
  // is tiny (welcomes, ok:false messages), so the size guard is a
  // backstop folded into the same warn, never an expected path.
  function sendAnswer(to: string, frame: ServerFrame, epoch: number): void {
    const { sendText, fits } = relayFrameTexts(to, frame, epoch);
    if (!fits) {
      console.warn(
        `[relay] failed to answer ${truncateId(to)}: answer exceeds the relay message limit`,
      );
      return;
    }
    sendAnswerText(to, sendText);
  }

  // Owner-initiated close of a client peer: tell the host we are gone
  // (a bye frame), then destroy locally. Without the bye the host's
  // hostSession for this peer (its AbortController and epoch record)
  // would survive as garbage until the next presence drop. Best
  // effort: a downed link just means the host finds out via presence
  // as before.
  function closeClientPeer(peer: ClientPeer): void {
    if (!peer.closed) {
      try {
        sendFrameToPeer(peer.deviceId, { t: "bye" }, peer.epoch);
      } catch {
        // The link is down or the frame did not fit. The host's
        // session then dies on presence, exactly the pre-bye behavior.
      }
    }
    destroyClientPeer(peer, new RelayLinkDownError());
  }

  // Kill one client peer. There is no close callback to owe: the one
  // real broker session lives inside the dialer's try/finally, which
  // closes it itself, so a session dying on its own only needs its
  // pending calls rejected.
  function destroyClientPeer(peer: ClientPeer, error: unknown): void {
    if (peer.closed) return;
    peer.closed = true;
    clientPeers.delete(peer.deviceId);
    if (peer.helloWaiter !== null) {
      clearTimeout(peer.helloWaiter.timer);
      peer.helloWaiter.reject(error);
      peer.helloWaiter = null;
    }
    // Reject all pending with a typed error so no pending entry can
    // survive into a new epoch (E2).
    rejectAllPending(peer, error);
  }

  function dropHostSession(deviceId: string): void {
    const session = hostSessions.get(deviceId);
    if (session === undefined) return;
    hostSessions.delete(deviceId);
    // Do NOT touch hostInFlight here. The count is keyed by deviceId and
    // is deliberately session-independent, so tearing a session down
    // (presence drop, nack, link teardown) must never reset it. A
    // hostile relay that flaps a peer's presence would otherwise zero
    // the counter while old dispatches are still running, letting a
    // re-hello drive concurrent dispatch above the cap. Aborting the
    // controller fires ctx.signal, so those old dispatches settle
    // promptly and each drains its own increment through the finally in
    // handleReq, which is the sole place the count is decremented or the
    // key deleted.
    session.controller.abort();
  }

  // ---- HOST role ----

  function handleHello(from: string, epoch: number): void {
    // Refuse a hello whose `from` is not in the most recent presence
    // roster (H4). A compromised DO can forge arbitrary `from` values,
    // each otherwise allocating a session, an AbortController and a
    // welcome. The DO always names real peers in presence, and a real
    // peer must be online to route a hello to us, so a roster gate is a
    // precise bound on session allocation.
    if (!online.has(from)) {
      warnDrop(() => `refusing hello from off-roster peer ${truncateId(from)}`);
      return;
    }
    // A fresh hello from a peer we already served means it reconnected.
    // The old session's controller aborts so its handlers unwind, but
    // the in-flight COUNT is left in place (it is keyed by deviceId and
    // is session-independent, see dropHostSession) so a re-hello cannot
    // raise the effective cap (H1). A new epoch means the peer will drop
    // any late frame stamped with the old one.
    const previous = hostSessions.get(from);
    if (previous !== undefined) previous.controller.abort();
    // The hello's token is deliberately IGNORED, never compared: the DO
    // already authenticated the account when it consumed the connect
    // ticket, and every deliverable peer is by construction a device of
    // the same account. See the trust-model note at the top of the file.
    const controller = new AbortController();
    const session: HostSession = {
      epoch,
      controller,
      // The minimal broker context (see RelayBrokerContext): the
      // authenticated caller (the DO consumed this peer's connect
      // ticket and stamps `from`, and the roster gate above already
      // bounded it to a real account device) and the session's abort
      // signal. No notifier and no grant verdict: the relay serves
      // only the broker read.
      ctx: {
        signal: controller.signal,
        callerDeviceId: from,
      },
    };
    hostSessions.set(from, session);
    sendAnswer(
      from,
      {
        t: "welcome",
        deviceId: deps.localDeviceId,
        appVersion: deps.localAppVersion,
      },
      epoch,
    );
  }

  // The peer's client role closed on purpose (a bye frame): tear its
  // host session down now instead of keeping it as garbage until
  // presence notices. Epoch-guarded so a late bye from a prior
  // pairing cannot kill the session a fresh hello just built.
  function handleBye(from: string, epoch: number): void {
    const session = hostSessions.get(from);
    if (session === undefined || session.epoch !== epoch) return;
    dropHostSession(from);
  }

  async function dispatch(
    from: string,
    session: HostSession,
    frame: ReqFrame,
  ): Promise<void> {
    let answer: ServerFrame;
    // The broker slot is the wire's whole serving policy: only the
    // broker channel ever reaches the handler, so a data channel (a
    // read, a mutation, anything) is refused with the same no-handler
    // shape an unregistered channel gets. There is nothing else to
    // mount on this binding: the slot's type is the wire's surface.
    const fn =
      frame.channel === deps.broker.channel ? deps.broker.handler : undefined;
    if (fn === undefined) {
      answer = {
        t: "res",
        id: frame.id,
        ok: false,
        message: noHandlerMessage(frame.channel),
      };
    } else {
      try {
        // Input parsing is unconditional inside fn (the owner's broker
        // wiring parses against the contract schema), exactly as the
        // shared registrar does on the LAN binding.
        const result = await fn(session.ctx, frame.input);
        answer = { t: "res", id: frame.id, ok: true, result };
      } catch (error) {
        // Message text only, mirroring what survives Electron's IPC error
        // serialization, so shared/errors.ts matchers behave the same on
        // every wire.
        answer = {
          t: "res",
          id: frame.id,
          ok: false,
          message: errorMessageOf(error),
        };
      }
    }
    // A re-hello or a presence drop between admission and completion
    // replaced or removed this session, so its answer must NOT ride the
    // new session (E3).
    if (hostSessions.get(from) !== session) return;
    // Pre-measure the ok:true result on the deliver shape. An oversize
    // one would otherwise be swallowed by the size guard and leave the
    // caller's invoke pending forever (there is no per-call timeout), so
    // downgrade to an ok:false the caller can reject on (C8). An ok:false
    // message is tiny and always fits.
    const encoded = relayFrameTexts(from, answer, session.epoch);
    if (!encoded.fits) {
      sendAnswer(
        from,
        {
          t: "res",
          id: frame.id,
          ok: false,
          message: "response too large for the relay",
        },
        session.epoch,
      );
      return;
    }
    sendAnswerText(from, encoded.sendText);
  }

  function handleReq(from: string, frame: ReqFrame, epoch: number): void {
    const session = hostSessions.get(from);
    if (session === undefined || epoch !== session.epoch) {
      // A req with no live session: before any hello, or stamped with a
      // prior pairing's epoch after a re-hello. A roster peer is a real
      // device whose invoke would otherwise hang forever (there is no
      // per-call timeout), so it gets a terminal ok:false stamped with
      // its own epoch, which its client accepts only while that pairing
      // is still current. An off-roster `from` is a misrouted or
      // spoofable routing field, so it stays a silent throttled drop.
      if (online.has(from)) {
        sendAnswer(
          from,
          { t: "res", id: frame.id, ok: false, message: "no live session" },
          epoch,
        );
      } else {
        warnDrop(() => `dropping req from off-roster peer ${truncateId(from)}`);
      }
      return;
    }
    const inFlight = hostInFlight.get(from) ?? 0;
    if (inFlight >= MAX_RELAY_IN_FLIGHT_PER_PEER) {
      sendAnswer(
        from,
        {
          t: "res",
          id: frame.id,
          ok: false,
          message: "too many in-flight requests",
        },
        session.epoch,
      );
      return;
    }
    hostInFlight.set(from, inFlight + 1);
    void dispatch(from, session, frame).finally(() => {
      const next = (hostInFlight.get(from) ?? 1) - 1;
      if (next <= 0) hostInFlight.delete(from);
      else hostInFlight.set(from, next);
    });
  }

  // ---- CLIENT role ----

  function connectBroker(deviceId: string): Promise<RelayBrokerSession> {
    // A fresh connect replaces any previous peer entry for the same
    // device: inbound frames route by deviceId, so there is exactly one
    // live client peer per target. A new epoch means any late frame from
    // the replaced pairing is dropped rather than mis-matched.
    const existing = clientPeers.get(deviceId);
    if (existing !== undefined) {
      destroyClientPeer(existing, new RelayLinkDownError());
    }
    const epoch = nextEpoch++;

    return new Promise<RelayBrokerSession>((resolve, reject) => {
      const peer: ClientPeer = {
        deviceId,
        epoch,
        nextId: 1,
        pending: new Map(),
        welcome: null,
        helloWaiter: null,
        closed: false,
        // The channel is pinned to the injected broker surface here,
        // so no caller can aim another channel's req at the relay: the
        // session's public invoke takes an input, never a channel.
        invoke(input: unknown): Promise<unknown> {
          if (peer.closed) {
            return Promise.reject(new RelayLinkDownError());
          }
          const id = peer.nextId++;
          return new Promise<unknown>((res, rej) => {
            peer.pending.set(id, { resolve: res, reject: rej });
            try {
              const channel = deps.broker.channel;
              // Omit input when undefined so a void contract input
              // rides as an absent field, matching the LAN wire.
              const frame =
                input === undefined
                  ? ({ t: "req", id, channel } as const)
                  : ({ t: "req", id, channel, input } as const);
              sendFrameToPeer(deviceId, frame, peer.epoch);
            } catch (error) {
              peer.pending.delete(id);
              rej(error);
            }
          });
        },
      };
      peer.helloWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          // The welcome never arrived. A retryable failure: the peer
          // may be mid-restart, so the caller decides whether to retry.
          destroyClientPeer(
            peer,
            new Error(`welcome timeout from relay peer ${deviceId}`),
          );
        }, HELLO_TIMEOUT_MS),
      };
      clientPeers.set(deviceId, peer);
      try {
        // The token is sent empty and the receiving side ignores it,
        // see handleHello. The DO already authenticated the account.
        sendFrameToPeer(
          deviceId,
          {
            t: "hello",
            token: "",
            deviceId: deps.localDeviceId,
            appVersion: deps.localAppVersion,
          },
          peer.epoch,
        );
      } catch (error) {
        destroyClientPeer(peer, error);
      }
    });
  }

  function handleServerFrame(
    from: string,
    frame: ServerFrame,
    epoch: number,
  ): void {
    const peer = clientPeers.get(from);
    if (peer === undefined) {
      // A reply from a peer we never helloed (or already dropped).
      // Nothing to route it to, so it is dropped, never fatal.
      return;
    }
    if (epoch !== peer.epoch) {
      // A stale frame from a prior pairing (a redial rides the same DO
      // socket), so it is dropped rather than matched against the fresh
      // session (E1/E2). This is the belt to E3's suspenders.
      warnDrop(
        () => `dropping stale-epoch ${frame.t} from ${truncateId(from)}`,
      );
      return;
    }
    if (frame.t === "welcome") {
      if (peer.helloWaiter === null || peer.welcome !== null) return;
      const waiter = peer.helloWaiter;
      peer.helloWaiter = null;
      clearTimeout(waiter.timer);
      // Identity is the DIALED deviceId. The welcome's self-asserted
      // deviceId is ignored: the DO already authenticated routing via the
      // accept tag, so a spoofed value must not be stored (M5).
      peer.welcome = { remoteAppVersion: frame.appVersion };
      waiter.resolve({
        brokerInvoke: (input) => peer.invoke(input),
        close: () => closeClientPeer(peer),
        remoteDeviceId: peer.deviceId,
        remoteAppVersion: frame.appVersion,
      });
      return;
    }
    if (frame.t === "res") {
      const entry = peer.pending.get(frame.id);
      if (entry === undefined) return;
      peer.pending.delete(frame.id);
      if (frame.ok) {
        entry.resolve(frame.result);
      } else if (frame.message === noHandlerMessage(deps.broker.channel)) {
        // The one answer that is a STRUCTURAL fact about the peer
        // rather than a failure of this call, so it is re-typed here
        // instead of being handed on as prose. The channel is not read
        // off the res (there is none): the client role only ever sends
        // reqs on the injected broker channel, so that IS the channel
        // this verdict is about.
        entry.reject(new RelayNoHandlerError(deps.broker.channel));
      } else {
        // A plain Error carrying the host's message text, so the
        // shared/errors.ts matchers degrade a remote handler failure
        // exactly as they do an Electron IPC one.
        entry.reject(new Error(frame.message));
      }
      return;
    }
    // A push frame. Nothing on this wire pushes anymore, so it can
    // only be a peer running an older app version fanning a cache ping
    // at us over the relay. Pushes are droppable by contract, so it is
    // counted and dropped rather than routed anywhere.
    warnDrop(() => `dropping relay push from ${truncateId(from)}`);
  }

  // ---- Envelope routing ----

  function applyPresence(list: readonly string[]): void {
    online = new Set(list);
    // Peers that vanished from the roster are gone: their client state
    // dies with the offline error and their host sessions abort. Both
    // loops only ever delete the entry they are visiting, which Map
    // iteration tolerates.
    for (const [deviceId, peer] of clientPeers) {
      if (!online.has(deviceId)) {
        destroyClientPeer(peer, new RelayPeerOfflineError(deviceId));
      }
    }
    for (const deviceId of hostSessions.keys()) {
      if (!online.has(deviceId)) dropHostSession(deviceId);
    }
    if (deps.onPresence !== undefined) {
      try {
        deps.onPresence([...list]);
      } catch (error) {
        console.warn(`[relay] onPresence threw: ${errorMessageOf(error)}`);
      }
    }
  }

  function handleNack(to: string, reason: "offline" | "too-large"): void {
    const peer = clientPeers.get(to);
    if (reason === "offline") {
      // A send to that peer bounced, so every bit of its state dies
      // now rather than waiting for the next presence broadcast.
      if (peer !== undefined) {
        destroyClientPeer(peer, new RelayPeerOfflineError(to));
      }
      dropHostSession(to);
      return;
    }
    // A nack carries no correlation id, so a too-large verdict cannot
    // name the one call it belongs to. Every pending call to that peer
    // rejects with the typed error. This path should be unreachable:
    // outbound sends pre-measure the exact deliver shape the DO does.
    if (peer !== undefined) {
      warnDrop(
        () => `too-large nack for ${truncateId(to)}, rejecting its pending`,
      );
      rejectAllPending(peer, new RelayMessageTooLargeError());
    }
  }

  return {
    handleMessage(text: string): void {
      const envelope = decodeEnvelope(text, ServerEnvelopeSchema);
      if (envelope === null) {
        // Malformed messages are dropped, never fatal, mirroring the
        // LAN socket. One bad message must not kill live traffic.
        warnDrop(() => "dropping unparseable envelope");
        return;
      }
      if (envelope.t === "presence") {
        applyPresence(envelope.online);
        return;
      }
      if (envelope.t === "nack") {
        handleNack(envelope.to, envelope.reason);
        return;
      }
      const parsed = RelayFrameSchema.safeParse(envelope.frame);
      if (!parsed.success) {
        warnDrop(
          () => `dropping unparseable frame from ${truncateId(envelope.from)}`,
        );
        return;
      }
      const { epoch, sm } = parsed.data;
      // The one role switch: hello, req and bye are requests TO us
      // (host role), everything else is a reply FOR us (client role).
      if (sm.t === "hello") {
        handleHello(envelope.from, epoch);
      } else if (sm.t === "req") {
        handleReq(envelope.from, sm, epoch);
      } else if (sm.t === "bye") {
        handleBye(envelope.from, epoch);
      } else {
        handleServerFrame(envelope.from, sm, epoch);
      }
    },

    connectBroker,

    onlineDeviceIds(): readonly string[] {
      return [...online].toSorted();
    },

    teardown(): void {
      const error = new RelayLinkDownError();
      // Both loops only ever delete the entry they are visiting, which
      // Map iteration tolerates.
      for (const peer of clientPeers.values()) {
        destroyClientPeer(peer, error);
      }
      for (const deviceId of hostSessions.keys()) {
        dropHostSession(deviceId);
      }
      if (online.size > 0) {
        online = new Set();
        if (deps.onPresence !== undefined) {
          try {
            deps.onPresence([]);
          } catch (err) {
            console.warn(`[relay] onPresence threw: ${errorMessageOf(err)}`);
          }
        }
      }
    },
  };
}
