// The relay link: the multiplexing core of the relay transport (v2
// step 4, slice C). One device holds ONE socket to its account's
// Durable Object, and both roles share it. The HOST role serves sm
// hello/req frames arriving from peers, mirroring the LAN binding's
// session semantics (per-peer notifier, AbortSignal, in-flight cap).
// The CLIENT role opens sm-level peer connections that carry req/res
// and push frames to a target deviceId. Role discrimination is purely
// the inner sm frame's `t` field: hello and req are requests TO us,
// welcome, res and push are replies FOR us. One decoder, one switch.
//
// COMPROMISED-RELAY TRUST MODEL: the Durable Object is LESS trusted than
// a LAN peer, see the TRUST MODEL note in protocol.ts. It sees all req
// and res plaintext, it can forge the `from` on a deliver, forge or
// replay a res or push, and lie about presence. The ignored hello token
// is safe only because the DO already authenticated the account when it
// burned the connect ticket, so every deliverable peer is by
// construction a device of the same account. Frame integrity is NOT
// verified in this slice. Per-device frame signing is the longer-term
// mitigation. What this file does defend: a per-session epoch stamped on
// every sm frame so a stale res or push from a prior peer pairing can
// never be matched against a fresh one, a presence-roster gate on hello
// so a forged `from` cannot allocate a host session, and per-peer caps.
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
  type PushFrame,
  type ReqFrame,
  type ServerFrame,
  ServerFrameSchema,
} from "@shared/ipc/socket/frames";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
import type { DeviceConnection } from "@shared/ipc/socket/wsClientTransport";
import type { HandlerContext } from "@shared/ipc/transport";
import {
  decodeEnvelope,
  encodeEnvelope,
  MAX_RELAY_MESSAGE_BYTES,
  relayTextWithinLimit,
  ServerEnvelopeSchema,
  utf8ByteLength,
} from "./protocol";

// Concurrent dispatched requests per peer, mirroring the LAN binding's
// per-socket cap so a chatty peer cannot spawn unbounded subprocesses.
// The count is tracked per deviceId and survives both a re-hello and a
// presence flap, so neither a peer re-helloing nor a hostile relay
// dropping and re-adding that peer from presence can reset the cap while
// old dispatches are still running.
const MAX_IN_FLIGHT_PER_PEER = 32;

// Skip a push once the outbound socket buffer passes this, mirroring the
// LAN binding's PUSH_BUFFER_LIMIT_BYTES, so a stalled relay cannot grow
// main-process memory without bound via queued pushes. Pushes are
// recoverable refresh signals, so dropping one is safe.
const PUSH_BUFFER_LIMIT_BYTES = 1 << 23;

// The inner frame union both roles decode from a delivered envelope.
const InnerFrameSchema = z.union([ClientFrameSchema, ServerFrameSchema]);

// Every sm frame the relay carries is wrapped with the session epoch.
// The wrapper lives in the relay layer only, so frames.ts and the LAN
// binding never learn about epochs. The DO forwards this whole object
// verbatim as the opaque `frame`, so the epoch survives the hop exactly
// as the sm frame does. The CLIENT owns the epoch: it mints a fresh one
// per connectPeer and sends it in hello, the HOST records it and echoes
// it on welcome/res/push, and the client drops any inbound frame whose
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
// deliver shape the DO measures. Chunking big frames into smaller
// envelopes is a later step, so today oversize is a hard error
// surfaced to the caller instead of a round trip ending in a nack.
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

// The LAN DeviceConnection shape verbatim, so everything downstream of
// connectPeer is transport agnostic.
export type PeerConnection = DeviceConnection;

export type ConnectPeerOpts = {
  // Called once when an ESTABLISHED peer connection dies on its own
  // (presence drop, nack, socket teardown). Never fires for an owner
  // initiated close, and never for a failed connect. The relay carries
  // no per-peer close code, so this takes no argument.
  onClose?: () => void;
  // Test seam for the welcome wait. Real callers take the LAN default.
  helloTimeoutMs?: number;
};

export type RelayLinkDeps = {
  localDeviceId: string;
  localAppVersion: string;
  // Writes one text message to the raw relay socket. May throw when the
  // socket is unusable, and the caller of the failed operation sees it.
  send(text: string): void;
  // The raw socket's queued-but-unsent byte count, for push backpressure.
  // Optional so a headless caller without a real socket can omit it.
  bufferedAmount?: () => number;
  // The registered host handlers, shared by reference with the owner so
  // registration at boot survives link recreation across reconnects.
  handlers: ReadonlyMap<
    string,
    (ctx: HandlerContext, raw: unknown) => Promise<unknown>
  >;
  // The full online list from every presence envelope, after the link
  // has reconciled its per-peer state against it.
  onPresence?: (online: readonly string[]) => void;
  // Every push frame delivered to a client peer, before local
  // subscribers run. The main process bridge forwards these to the
  // renderer wholesale, and the renderer filters by device and channel.
  onPeerPush?: (deviceId: string, channel: string, payload: unknown) => void;
};

export type RelayLink = {
  // Feed one raw text message from the relay socket through the link.
  handleMessage(text: string): void;
  // CLIENT role: open an sm-level connection to a peer device. Sends
  // hello, awaits welcome, then invoke correlates req/res by id and
  // subscribe consumes that peer's push frames.
  connectPeer(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
  // HOST role fan-out: one push frame to every peer that has helloed.
  broadcastAll(channel: string, payload: unknown): void;
  onlineDeviceIds(): readonly string[];
  // The appVersion each currently connected client peer confirmed in its
  // welcome, so the owner can fold it into a status snapshot instead of
  // the renderer polling per device.
  peerAppVersions(): Record<string, string>;
  // The socket is gone: every peer's state dies, in-flight calls
  // reject, host sessions abort, and established peer connections see
  // their close callback.
  teardown(): void;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type ClientPeer = {
  deviceId: string;
  // This pairing's epoch, minted at connectPeer. Stamped on every
  // outbound frame and checked against every inbound one.
  epoch: number;
  nextId: number;
  pending: Map<number, PendingCall>;
  subscribers: ReturnType<typeof createSubscriberRegistry>;
  // Non-null once the peer's welcome landed. remoteAppVersion is
  // informational; the peer identity is the DIALED deviceId, never the
  // welcome's self-asserted one (M5).
  welcome: { remoteAppVersion: string } | null;
  helloWaiter: {
    resolve: (connection: PeerConnection) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  onClose: (() => void) | null;
  transport: PeerConnection["transport"];
  closed: boolean;
};

type HostSession = {
  // The epoch recorded from this peer's most recent hello, echoed on
  // every welcome/res/push so the peer can drop a stale one.
  epoch: number;
  controller: AbortController;
  ctx: HandlerContext;
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
  // A fresh epoch per connectPeer. A monotonic integer is enough: it
  // only needs to differ from the pairing it replaces.
  let nextEpoch = 1;
  let droppedPushes = 0;
  let droppedInbound = 0;

  // Throttled warn for the hostile inbound paths (forged/unparseable
  // frames, un-helloed or off-roster peers), so a flood cannot spam the
  // log the way an unthrottled warn per drop would.
  function warnDrop(message: string): void {
    droppedInbound += 1;
    if (droppedInbound % 50 === 1) {
      console.warn(
        `[relay] ${message} (dropped ${droppedInbound} inbound so far)`,
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

  // The one outbound path for sm frames. Oversize is a hard local error
  // today, never a wire round trip (chunking is a later step).
  function sendFrameToPeer(
    to: string,
    frame: ClientFrame | ServerFrame,
    epoch: number,
  ): void {
    const { sendText, fits } = relayFrameTexts(to, frame, epoch);
    if (!fits) throw new RelayMessageTooLargeError();
    deps.send(sendText);
  }

  // Push delivery is best effort, mirroring the LAN binding's
  // backpressure drops: a push is a recoverable refresh signal, so a
  // backpressured, oversize or failed one is counted and dropped rather
  // than thrown into the broadcaster.
  function trySendPush(to: string, frame: PushFrame, epoch: number): void {
    if (
      deps.bufferedAmount !== undefined &&
      deps.bufferedAmount() > PUSH_BUFFER_LIMIT_BYTES
    ) {
      droppedPushes += 1;
      if (droppedPushes % 50 === 1) {
        console.warn(
          `[relay] dropping push under backpressure (dropped ${droppedPushes} so far)`,
        );
      }
      return;
    }
    try {
      sendFrameToPeer(to, frame, epoch);
    } catch (error) {
      droppedPushes += 1;
      if (droppedPushes % 50 === 1) {
        console.warn(
          `[relay] dropping push to ${truncateId(to)}: ${errorMessageOf(error)} (dropped ${droppedPushes} so far)`,
        );
      }
    }
  }

  // Answers a caller is awaiting (welcome, res). A send failure here is
  // logged, not thrown: the peer's side times out or sees the
  // disconnect, exactly as it would on a dead LAN socket.
  function sendAnswer(to: string, frame: ServerFrame, epoch: number): void {
    try {
      sendFrameToPeer(to, frame, epoch);
    } catch (error) {
      console.warn(
        `[relay] failed to answer ${truncateId(to)}: ${errorMessageOf(error)}`,
      );
    }
  }

  // Kill one client peer. fireClose distinguishes the peer dying on its
  // own (close callback owed, post-welcome only) from an owner close or
  // a replacement (silent). The relay carries no per-peer close code.
  function destroyClientPeer(
    peer: ClientPeer,
    error: unknown,
    fireClose: boolean,
  ): void {
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
    if (fireClose && peer.welcome !== null) peer.onClose?.();
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
      warnDrop(`refusing hello from off-roster peer ${truncateId(from)}`);
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
      ctx: {
        signal: controller.signal,
        // Bound to the calling peer only, so a handler streaming progress
        // reaches its caller rather than every peer. A notifier that
        // fires after a re-hello or a presence drop must not push into
        // the new session, so it no-ops unless it is still current (E3).
        notifier: (module, key) => (payload) => {
          if (hostSessions.get(from) !== session) return;
          const { channel, parsed } = resolveBroadcast(module, key, payload);
          trySendPush(from, { t: "push", channel, payload: parsed }, epoch);
        },
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

  async function dispatch(
    from: string,
    session: HostSession,
    frame: ReqFrame,
  ): Promise<void> {
    let answer: ServerFrame;
    const fn = deps.handlers.get(frame.channel);
    if (fn === undefined) {
      // Non-remote and client-scoped channels are never registered on
      // this binding, so this is also the answer a peer gets for them.
      answer = {
        t: "res",
        id: frame.id,
        ok: false,
        message: `No handler registered for channel "${frame.channel}"`,
      };
    } else {
      try {
        // Input parsing is unconditional inside fn (the shared registrar
        // wraps every handler), exactly as on the LAN binding.
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
    try {
      deps.send(encoded.sendText);
    } catch (error) {
      console.warn(
        `[relay] failed to answer ${truncateId(from)}: ${errorMessageOf(error)}`,
      );
    }
  }

  function handleReq(from: string, frame: ReqFrame, epoch: number): void {
    const session = hostSessions.get(from);
    if (session === undefined) {
      // A req before hello is a protocol violation. There is no socket
      // of theirs to close here, so it is dropped with a throttled log.
      warnDrop(`dropping req from un-helloed peer ${truncateId(from)}`);
      return;
    }
    if (epoch !== session.epoch) {
      // A stale req from a prior pairing, arriving after a re-hello.
      warnDrop(`dropping stale-epoch req from ${truncateId(from)}`);
      return;
    }
    const inFlight = hostInFlight.get(from) ?? 0;
    if (inFlight >= MAX_IN_FLIGHT_PER_PEER) {
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

  function connectPeer(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection> {
    // A fresh connect replaces any previous peer entry for the same
    // device: inbound frames route by deviceId, so there is exactly one
    // live client peer per target. A new epoch means any late frame from
    // the replaced pairing is dropped rather than mis-matched.
    const existing = clientPeers.get(deviceId);
    if (existing !== undefined) {
      destroyClientPeer(existing, new RelayLinkDownError(), false);
    }
    const helloTimeoutMs = opts?.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    const epoch = nextEpoch++;

    return new Promise<PeerConnection>((resolve, reject) => {
      const peer: ClientPeer = {
        deviceId,
        epoch,
        nextId: 1,
        pending: new Map(),
        subscribers: createSubscriberRegistry("relay"),
        welcome: null,
        helloWaiter: null,
        onClose: opts?.onClose ?? null,
        closed: false,
        transport: {
          invoke(channel: string, input: unknown): Promise<unknown> {
            if (peer.closed) {
              return Promise.reject(new RelayLinkDownError());
            }
            const id = peer.nextId++;
            return new Promise<unknown>((res, rej) => {
              peer.pending.set(id, { resolve: res, reject: rej });
              // Omit input when undefined so a void contract input
              // rides as an absent field, matching the LAN wire.
              const frame =
                input === undefined
                  ? ({ t: "req", id, channel } as const)
                  : ({ t: "req", id, channel, input } as const);
              try {
                sendFrameToPeer(deviceId, frame, peer.epoch);
              } catch (error) {
                peer.pending.delete(id);
                rej(error);
              }
            });
          },
          subscribe(
            channel: string,
            handler: (payload: unknown) => void,
          ): () => void {
            return peer.subscribers.subscribe(channel, handler);
          },
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
            false,
          );
        }, helloTimeoutMs),
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
        destroyClientPeer(peer, error, false);
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
      warnDrop(`dropping stale-epoch ${frame.t} from ${truncateId(from)}`);
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
        transport: peer.transport,
        close: () => destroyClientPeer(peer, new RelayLinkDownError(), false),
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
      } else {
        // A plain Error carrying the host's message text, so the
        // shared/errors.ts matchers degrade a remote handler failure
        // exactly as they do an Electron IPC one.
        entry.reject(new Error(frame.message));
      }
      return;
    }
    // A push from this peer. The bridge callback sees every push, then
    // local subscribers fan out. The bridge callback is wrapped so a
    // throw there cannot escape into the socket's message handler (M4).
    if (deps.onPeerPush !== undefined) {
      try {
        deps.onPeerPush(from, frame.channel, frame.payload);
      } catch (error) {
        console.warn(`[relay] onPeerPush threw: ${errorMessageOf(error)}`);
      }
    }
    peer.subscribers.emit(frame.channel, frame.payload);
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
        destroyClientPeer(peer, new RelayPeerOfflineError(deviceId), true);
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
        destroyClientPeer(peer, new RelayPeerOfflineError(to), true);
      }
      dropHostSession(to);
      return;
    }
    // A nack carries no correlation id, so a too-large verdict cannot
    // name the one call it belongs to. Every pending call to that peer
    // rejects with the typed error. This path should be unreachable:
    // outbound sends pre-measure the exact deliver shape the DO does.
    if (peer !== undefined) {
      warnDrop(`too-large nack for ${truncateId(to)}, rejecting its pending`);
      rejectAllPending(peer, new RelayMessageTooLargeError());
    }
  }

  return {
    handleMessage(text: string): void {
      const envelope = decodeEnvelope(text, ServerEnvelopeSchema);
      if (envelope === null) {
        // Malformed messages are dropped, never fatal, mirroring the
        // LAN socket. One bad message must not kill live traffic.
        warnDrop("dropping unparseable envelope");
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
          `dropping unparseable frame from ${truncateId(envelope.from)}`,
        );
        return;
      }
      const { epoch, sm } = parsed.data;
      // The one role switch: hello and req are requests TO us (host
      // role), everything else is a reply FOR us (client role).
      if (sm.t === "hello") {
        handleHello(envelope.from, epoch);
      } else if (sm.t === "req") {
        handleReq(envelope.from, sm, epoch);
      } else {
        handleServerFrame(envelope.from, sm, epoch);
      }
    },

    connectPeer,

    broadcastAll(channel: string, payload: unknown): void {
      const frame: PushFrame = { t: "push", channel, payload };
      for (const [deviceId, session] of hostSessions) {
        trySendPush(deviceId, frame, session.epoch);
      }
    },

    onlineDeviceIds(): readonly string[] {
      return [...online].toSorted();
    },

    peerAppVersions(): Record<string, string> {
      const versions: Record<string, string> = {};
      for (const [deviceId, peer] of clientPeers) {
        if (peer.welcome !== null)
          versions[deviceId] = peer.welcome.remoteAppVersion;
      }
      return versions;
    },

    teardown(): void {
      const error = new RelayLinkDownError();
      // Both loops only ever delete the entry they are visiting, which
      // Map iteration tolerates.
      for (const peer of clientPeers.values()) {
        destroyClientPeer(peer, error, true);
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
