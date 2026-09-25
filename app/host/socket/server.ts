// Websocket binding of the shared ServerTransport: the host side of the
// direct data plane, serving device-to-device data over direct sockets.
// Registration and listening are decoupled on purpose:
// main/ipc/register.ts records every REMOTE host handler here at boot
// whether or not the device is enrolled, so signing in later only
// starts the socket.
//
// Auth is a single-use connect ticket minted over the device hub and
// bound to the hello deviceId (WsServerTicketAuth). Dispatch serves a
// channel registered mutating:false to every authed peer, and anything
// else (a mutation, or an untagged channel) only under the host's live
// command-access switch, refused with the shared command-refused code
// before its handler runs otherwise. One authed socket per deviceId,
// with supersede.
//
// The listener sits on every interface (and behind the tunnel), so it
// is written to be hostile-safe: a small inbound frame cap, an Origin
// gate, connection and in-flight caps, failed-auth lockout,
// backpressure on pushes, and hard termination (not advisory close) on
// every rejection and shutdown.
//
// This file must stay Electron free (pnpm test host-boundary). The
// Electron facts a listener needs (appVersion) arrive through start
// opts instead.
import type { IncomingMessage } from "node:http";
import { deflateRaw } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { errorMessageOf } from "@shared/errors";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_AUTH_LOCKED_OUT,
  CLOSE_GOING_AWAY,
  CLOSE_HELLO_FAILED,
  CLOSE_OVER_CAPACITY,
  ClientFrameSchema,
  COMMAND_REFUSED_CODE,
  COMMAND_REFUSED_MESSAGE,
  decodeFrame,
  encodeFrame,
  HELLO_TIMEOUT_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  MAX_IN_FLIGHT_PER_PEER,
  MAX_INBOUND_FRAME_BYTES,
  noHandlerMessage,
  PUSH_BUFFER_LIMIT_BYTES,
  type ReqFrame,
  type ServerFrame,
  TERMINATE_GRACE_MS,
  resError,
} from "@shared/ipc/socket/frames";
import {
  handshakeProof,
  newHandshakeNonce,
  proofsMatch,
} from "@shared/ipc/socket/proof";
import {
  DEFLATE_MIN_TEXT_LENGTH,
  DEFLATED_FRAME_KIND,
} from "@shared/ipc/socket/deflatedFrame";
import type { DirectCandidateKind } from "@shared/ipc/modules/direct";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import { createLimiter } from "@shared/util/limit";
import {
  createChannelMux,
  createUnknownChannelFrameWarner,
} from "@shared/ipc/socket/channels";
import type { RawData } from "ws";
import { toBytes, toText } from "./rawData";

// The binding's auth: short-lived single-use connect tickets minted
// over the device hub. Injected at binding creation so this module
// stays free of the ticket store and the grant store alike.
export type WsServerTicketAuth = {
  // Consumes the connect ticket the client proved possession of (it
  // never travels, see shared/ipc/socket/proof.ts), for the claimed
  // deviceId and the path the connection arrived on. Returns it so this
  // binding can compute the host's half, or null when nothing matches.
  matchTicket(
    deviceId: string,
    arrivedAs: DirectCandidateKind,
    matches: (ticket: string) => Promise<boolean>,
  ): Promise<string | null>;
  // Whether this host runs MUTATING calls from its ticketed peers at
  // all (every ticketed peer is a device of the same account), read
  // live at every dispatch (never cached on the session) so flipping
  // the switch takes effect without a reconnect, mirroring the hub
  // link.
  isCommandGranted(): boolean;
};

export type WsServerStartOpts = {
  port: number;
  // Where the listener binds. main binds "::" (dual stack: both
  // families accept), because it advertises IPv6 candidates too and an
  // IPv4-only bind would make every one of them guaranteed dead. Tests
  // bind loopback. Kept as a resolved string so this module never
  // reads config.
  bindAddress: string;
  // The host root's id and the host app's version, echoed in the
  // welcome frame. appVersion is an Electron fact, so the caller
  // injects it here rather than this module importing electron.
  deviceId: string;
  appVersion: string;
  // The account the listener serves. An IDENTITY field, compared in
  // sameListener, so an account switch restarts the listener and drops
  // every authed socket from the old account instead of leaving them
  // live under the new one. Unset in tests.
  accountId?: string;
  // Extra exact-match Origin the upgrade gate admits: the configured
  // web client's origin, so a browser dial arriving through the wss
  // tunnel passes. Unset admits origin-less and loopback http origins
  // only (see isAllowedOrigin).
  allowedOrigin?: string;
  // Test seam. Real callers take the 10s default.
  helloTimeoutMs?: number;
  // Test seam for the host-side liveness sweep (HOST_LIVENESS_TIMEOUT_MS
  // in frames.ts). Real callers take the shared default.
  livenessTimeoutMs?: number;
};

// Observable listener state so a bind failure (port taken, EACCES) is
// not a silent enabled-but-not-listening hole. Exposed via status().
export type WsServerStatus = {
  listening: boolean;
  port: number | null;
  bindAddress: string | null;
  error: string | null;
};

export type WsServerBinding = ServerTransport & {
  // Resolves with the bound port (meaningful when opts.port is 0),
  // rejects when the bind fails. Rejects when already started:
  // reconciliation goes through refresh.
  start(opts: WsServerStartOpts): Promise<number>;
  stop(): Promise<void>;
  // Reconciles the listener with the wanted state. The resolver runs
  // INSIDE the serialized lifecycle so the state read and the reconcile
  // are atomic: two overlapping refreshes cannot apply a stale read
  // last (an account switch can never be silently reverted). It returns
  // null to stop, or opts to (re)start unless the running listener
  // already matches them.
  refresh(resolve: () => Promise<WsServerStartOpts | null>): Promise<void>;
  status(): WsServerStatus;
  // Kill the authed sockets whose peer deviceId is not in the given
  // roster. Presence scopes the data plane: the
  // hub brokers membership, so a peer absent from a live roster (a
  // revoked device, an account switch on its side) loses its direct
  // socket within one presence broadcast. The caller must only pass a
  // roster it trusts as live, see shared/hub/directPresence.ts.
  closePeersNotIn(online: readonly string[]): void;
};

// Total sockets (authed plus pending) the listener will hold. Over this
// a new connection is closed before any per-connection state is built.
const MAX_CONNECTIONS = 64;
// Un-welcomed sockets held at once. A separate, tighter cap so a flood
// of connections that never say hello cannot crowd out real peers.
const MAX_PREAUTH_CONNECTIONS = 16;
// The in-flight, push-backpressure and terminate-grace bounds are the
// shared wire caps in frames.ts, so this binding and the hub link
// cannot drift apart on them.
// Let a rejection's close frame flush before the socket is destroyed,
// so the peer sees the code. The dead flag already blocks any frame
// arriving in this gap, so correctness does not depend on the delay.
const REJECT_TERMINATE_DELAY_MS = 50;
// Failed-proof attempts from one client identity before a lockout
// window starts, so a bad ticket is not a free infinite retry loop.
const AUTH_FAILURE_LIMIT = 5;
const AUTH_LOCKOUT_MS = 30_000;

// How often at most the listener logs a refused web Origin. A deployment whose desktop never set SM_ACCOUNT_WEB_ORIGIN
// would otherwise be a silent stream of bare upgrade refusals with no
// clue on either side.
const ORIGIN_REJECT_LOG_THROTTLE_MS = 60_000;

function isLoopbackAddress(address: string): boolean {
  return (
    address.startsWith("127.") ||
    address === "::1" ||
    address.startsWith("::ffff:127.")
  );
}

// The identity lockout, caps and log lines key on: the socket's
// remoteAddress, except for connections arriving through the local
// cloudflared connector, which ALL land on loopback: keying those on
// remoteAddress would collapse every tunnel-borne client into one
// 127.0.0.1 bucket, letting 5 bad tickets from anywhere on the internet
// bench every tunnel dial for the lockout window, forever renewable.
// cloudflared forwards the real client address in CF-Connecting-IP, so
// a loopback connection keys on that header instead when present. Only
// loopback connections may delegate to the header: a LAN peer cannot
// spoof its way into another bucket because its remoteAddress is not
// loopback.
export function clientIdentityOf(
  remoteAddress: string | undefined,
  cfConnectingIp: string | undefined,
): string {
  if (!tunnelBorne(remoteAddress, cfConnectingIp)) {
    return remoteAddress ?? "unknown";
  }
  return (cfConnectingIp ?? "").trim();
}

// Whether the local cloudflared connector delivered this connection.
// One predicate, because the lockout bucket above and the candidate
// kind below must never disagree about the same connection.
function tunnelBorne(
  remoteAddress: string | undefined,
  cfConnectingIp: string | undefined,
): boolean {
  return (
    isLoopbackAddress(remoteAddress ?? "unknown") &&
    (cfConnectingIp?.trim() ?? "") !== ""
  );
}

// Which advertised candidate a connection came in on, so a ticket can
// be held to the kind it was minted for.
export function arrivalKindOf(
  remoteAddress: string | undefined,
  cfConnectingIp: string | undefined,
): DirectCandidateKind {
  return tunnelBorne(remoteAddress, cfConnectingIp) ? "tunnel" : "lan";
}

// The hello check. Resolves the host's half of the mutual proof when
// the client proved one of its pending tickets, else null.
async function answerProof(
  auth: WsServerTicketAuth,
  hostNonce: string,
  arrivedAs: DirectCandidateKind,
  hello: { deviceId: string; nonce?: string; proof?: string },
): Promise<string | null> {
  const { nonce, proof } = hello;
  if (nonce === undefined || proof === undefined) return null;
  const ticket = await auth.matchTicket(
    hello.deviceId,
    arrivedAs,
    async (candidate) =>
      proofsMatch(
        proof,
        await handshakeProof(candidate, "client", hostNonce, nonce),
      ),
  );
  if (ticket === null) return null;
  return handshakeProof(ticket, "host", hostNonce, nonce);
}

// Origin pre-filter for the upgrade, NOT the security boundary: the
// hello's ticket proof is what actually authenticates a peer (a bad
// proof terminates the socket). Legitimate clients are the desktop's
// main-process dialer, which sends no Origin, and the web client,
// whose browser-global WebSocket always sends one: a loopback http
// origin from a locally served web client, or the ONE configured
// web-client origin, so the deployed web client can dial wss tunnel
// URLs. The exact-match `allowedOrigin` arrives through start opts
// from the same SM_ACCOUNT_WEB_ORIGIN env the app's account layer
// reads, never hardcoded. Anything else is a drive-by browser page,
// refused before it can even attempt a hello.
export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigin?: string,
): boolean {
  if (origin === undefined) return true;
  if (allowedOrigin !== undefined && origin === allowedOrigin) return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

const DEFLATED_FRAME_PREFIX = Buffer.from([DEFLATED_FRAME_KIND]);

// The ordered writer of each socket the host deflates for
// (shared/ipc/socket/deflatedFrame.ts): a tunnel-borne connection whose
// hello asked. Every other socket has no entry and its frames go
// straight out. A LAN peer is left alone on purpose: its link outruns
// the deflate, which would then be the slow part of a bundle transfer.
type FrameWriter = (data: string | Uint8Array) => void;
const deflatingWriters = new WeakMap<WebSocket, FrameWriter>();

// The raw-deflate bytes of a frame's text, or null when it is not
// worth sending that way (it did not shrink, or zlib refused).
function deflated(text: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const raw = Buffer.from(text, "utf8");
    deflateRaw(raw, (error, bytes) => {
      resolve(error === null && bytes.length + 1 < raw.length ? bytes : null);
    });
  });
}

// Deflating is async (zlib's thread pool, so a megabyte of diff never
// blocks the host's loop), and a frame that finishes late must not be
// overtaken by the ones behind it: script output arrives as ordered
// pushes, and a channel's bytes keep their place among the JSON frames.
// So while a deflate is outstanding every later frame of the socket
// queues behind it, and with none outstanding a frame that needs no
// deflating goes straight out and pays nothing.
function createDeflatingWriter(socket: WebSocket): FrameWriter {
  let queued = 0;
  const inOrder = createLimiter(1);
  const write = (data: string | Uint8Array): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  };
  return (data) => {
    const text =
      typeof data === "string" && data.length >= DEFLATE_MIN_TEXT_LENGTH
        ? data
        : null;
    if (queued === 0 && text === null) {
      write(data);
      return;
    }
    queued += 1;
    void inOrder(async () => {
      try {
        const bytes = text === null ? null : await deflated(text);
        if (bytes === null) write(data);
        else write(Buffer.concat([DEFLATED_FRAME_PREFIX, bytes]));
      } catch (error) {
        // A send that threw (the socket dying under it) loses this
        // frame only, not the ones queued behind it.
        console.warn(`[socket] queued send failed: ${errorMessageOf(error)}`);
      } finally {
        queued -= 1;
      }
    });
  };
}

function sendData(socket: WebSocket, data: string | Uint8Array): void {
  const writer = deflatingWriters.get(socket);
  if (writer === undefined) socket.send(data);
  else writer(data);
}

// Unconditional send for res and welcome frames: these are answers a
// caller is awaiting, so they are never dropped under backpressure.
function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  sendData(socket, encodeFrame(frame));
}

export function createWsServerBinding(
  auth: WsServerTicketAuth,
): WsServerBinding {
  const handlers = new Map<
    string,
    (ctx: HandlerContext, raw: unknown) => Promise<unknown>
  >();
  // The channel names EXPLICITLY registered read-only (mutating:false),
  // collected fail-closed: dispatch serves a channel ungated ONLY when
  // it is in here, so a mutation or an untagged channel needs the
  // command-access switch even though it is registered.
  const readOnlyChannels = new Set<string>();
  // Sockets past hello, each with its liveness record
  // (HOST_LIVENESS_TIMEOUT_MS in frames.ts): when its last frame
  // arrived, whether it has ever pinged (only a peer that proved it
  // heartbeats is judged, so an older client that never pings is left
  // alone), and the kill that ends it. broadcastAll fans out to exactly
  // this set, so an unauthenticated connection can never receive a
  // push, and one timer per listener sweeps it so a dead client socket
  // cannot sit here until the OS notices.
  type Liveness = {
    lastInboundAt: number;
    heartbeats: boolean;
    kill(code: number, reason: string): void;
  };
  const authed = new Map<WebSocket, Liveness>();
  let livenessTimer: NodeJS.Timeout | null = null;
  // The one authed peer per deviceId. A device dials
  // at most one direct socket to a given peer, so a duplicate authed
  // connection from the same deviceId supersedes the older one,
  // mirroring the DO's behavior for its own sockets. The entry carries
  // the connection's kill function (its dead flag and AbortController
  // are closure locals of that connection), so supersede and the
  // roster close can END the old connection: closeThenTerminate alone
  // would let the old socket keep dispatching req frames for the close
  // grace window, and a mutating invoke could execute twice.
  type AuthedPeer = {
    socket: WebSocket;
    kill(code: number, reason: string): void;
  };
  const authedByDevice = new Map<string, AuthedPeer>();
  let listener: {
    wss: WebSocketServer;
    opts: WsServerStartOpts;
    generation: number;
  } | null = null;
  // Stamped onto every listener so dispatch can tell a peer on the
  // current listener from one left on a stopped or rotated one.
  let generationCounter = 0;
  // Un-welcomed sockets currently held, for the pre-auth cap.
  let preAuthCount = 0;
  let droppedPushes = 0;
  // Last time an Origin refusal was logged, for the throttle.
  let originRejectLoggedAt = 0;
  // Failed-proof attempts per client identity (clientIdentityOf), for
  // lockout.
  const failedAuth = new Map<string, { count: number; until: number }>();
  let status: WsServerStatus = {
    listening: false,
    port: null,
    bindAddress: null,
    error: null,
  };
  // Serializes start/stop/refresh so two quick reconciles (an account
  // change racing a config write) cannot interleave one refresh's stop
  // with another's start.
  const lifecycle = createLimiter(1);

  function isLockedOut(ip: string): boolean {
    const entry = failedAuth.get(ip);
    if (entry === undefined) return false;
    if (entry.until <= Date.now()) {
      // The window elapsed, whether the entry ever reached the limit or
      // not: forget it so a later genuine attempt starts clean.
      failedAuth.delete(ip);
      return false;
    }
    return entry.count >= AUTH_FAILURE_LIMIT;
  }

  function recordAuthFailure(ip: string): void {
    const now = Date.now();
    // Every failure stamps an expiry, so an IP that fails a few times
    // and never returns cannot leave a permanent entry, and expired
    // entries are pruned here so the map stays bounded by the IPs seen
    // within one window. Locked means count over the limit AND a live
    // window.
    for (const [key, entry] of failedAuth) {
      if (entry.until <= now) failedAuth.delete(key);
    }
    const entry = failedAuth.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    entry.until = now + AUTH_LOCKOUT_MS;
    failedAuth.set(ip, entry);
  }

  function sendPushText(socket: WebSocket, text: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > PUSH_BUFFER_LIMIT_BYTES) {
      droppedPushes += 1;
      if (droppedPushes % 50 === 1) {
        console.warn(
          `[socket] dropping push under backpressure (dropped ${droppedPushes} so far)`,
        );
      }
      return;
    }
    sendData(socket, text);
  }

  // close() alone is advisory: ws keeps delivering inbound frames for up
  // to ~30s. Send the close frame, then terminate so the socket is truly
  // gone. Callers set their dead flag first, so nothing is processed in
  // the flush gap.
  function closeThenTerminate(
    socket: WebSocket,
    code: number,
    reason: string,
  ): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already closing.
    }
    setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // Already gone.
      }
    }, REJECT_TERMINATE_DELAY_MS);
  }

  async function dispatch(
    socket: WebSocket,
    ctx: HandlerContext,
    frame: ReqFrame,
    generation: number,
  ): Promise<void> {
    // Generation guard: a peer left on a stopped listener (listener is
    // null) or a rotated one (different generation), including one still
    // alive inside the terminate grace window, executes nothing.
    if (listener === null || listener.generation !== generation) {
      send(socket, resError(frame.id, "listener no longer active"));
      return;
    }
    const fn = handlers.get(frame.channel);
    if (fn === undefined) {
      // Client-scoped and non-remote host channels are never registered
      // on this binding (main/ipc/register.ts withholds them), so this
      // is also the answer a remote peer gets for them.
      send(socket, resError(frame.id, noHandlerMessage(frame.channel)));
      return;
    }
    if (!readOnlyChannels.has(frame.channel)) {
      // Fail-closed gate on anything not proven a read (explicitly
      // registered mutating:false): consult the injected
      // command-access switch LIVE at each call, never cached on the
      // session, so flipping it takes effect without a reconnect. The
      // refusal carries the typed code so the client transport
      // surfaces "that machine will not run commands from here"
      // distinctly from a real failure. The session's context already
      // carries the live verdict, so dispatch asks it rather than
      // re-deriving from the auth seam.
      if (ctx.isCallerCommandGranted?.() !== true) {
        send(
          socket,
          resError(frame.id, COMMAND_REFUSED_MESSAGE, COMMAND_REFUSED_CODE),
        );
        return;
      }
    }
    try {
      const result = await fn(ctx, frame.input);
      send(socket, { t: "res", id: frame.id, ok: true, result });
    } catch (error) {
      // Message text only, mirroring what survives Electron's IPC
      // error serialization, so the shared/errors.ts matchers behave
      // the same on both wires.
      send(socket, resError(frame.id, errorMessageOf(error)));
    }
  }

  function attach(
    wss: WebSocketServer,
    opts: WsServerStartOpts,
    generation: number,
  ): void {
    const helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    wss.on("connection", (socket, req) => {
      const forwardedFor = req.headers["cf-connecting-ip"];
      const cfConnectingIp = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : forwardedFor;
      const ip = clientIdentityOf(req.socket.remoteAddress, cfConnectingIp);
      const arrivalKind = arrivalKindOf(
        req.socket.remoteAddress,
        cfConnectingIp,
      );
      // Caps are checked before any controller or timer is allocated.
      if (authed.size + preAuthCount >= MAX_CONNECTIONS) {
        closeThenTerminate(socket, CLOSE_OVER_CAPACITY, "over capacity");
        return;
      }
      if (preAuthCount >= MAX_PREAUTH_CONNECTIONS) {
        closeThenTerminate(
          socket,
          CLOSE_OVER_CAPACITY,
          "too many pending connections",
        );
        return;
      }
      if (isLockedOut(ip)) {
        console.warn(`[socket] rejecting connection from locked-out ${ip}`);
        // A DISTINCT code from the bad-credential refusal below, and
        // the distinction is load-bearing: this close happens before
        // any hello is read, so the client it refuses may hold a
        // perfectly good ticket and simply share an IP with whoever
        // burned the attempts. Only this side knows that. Sending
        // AUTH_FAILED here made a temporary, self-expiring bench look
        // to the client exactly like a refused credential, which the
        // direct keeper answers by parking with no timer -- so the
        // lockout lifted 30s later and nothing ever redialed.
        closeThenTerminate(
          socket,
          CLOSE_AUTH_LOCKED_OUT,
          "temporarily locked out",
        );
        return;
      }

      preAuthCount += 1;
      let leftPreAuth = false;
      const leavePreAuth = (): void => {
        if (leftPreAuth) return;
        leftPreAuth = true;
        preAuthCount -= 1;
      };

      // Set on any rejection or timeout so no frame is processed after,
      // even though ws may still deliver buffered frames while closing.
      let dead = false;
      // Non-null once the hello handshake succeeded. Everything before
      // that is answered only with the challenge and a close code: this
      // listener sits on every interface, so pre-auth traffic gets
      // nothing else.
      let ctx: HandlerContext | null = null;
      let inFlight = 0;
      const controller = new AbortController();
      // Byte channels on THIS socket (shared/ipc/socket/channels.ts):
      // binary frames route here, handlers attach far ends through the
      // context, and every endpoint is reset when the socket dies.
      const channels = createChannelMux({
        send: (frame) => {
          if (socket.readyState !== WebSocket.OPEN) {
            throw new Error("socket not open");
          }
          sendData(socket, frame);
        },
      });
      const warnUnknownChannelFrame = createUnknownChannelFrameWarner("socket");

      // The host opens the handshake: the client cannot hello until it
      // has this nonce. Not a secret, so it goes out pre-auth.
      const hostNonce = newHandshakeNonce();
      send(socket, { t: "challenge", nonce: hostNonce });
      // One hello per connection, latched before the proof check
      // awaits: two hellos racing through the await would otherwise
      // both see ctx === null and both authenticate.
      let helloSeen = false;

      // A hello arriving after this fires must not authenticate.
      const helloTimer = setTimeout(
        () => kill(CLOSE_HELLO_FAILED, "hello timeout"),
        helloTimeoutMs,
      );

      // Out of every map, its channels closed, its in-flight handlers
      // unwinding. Idempotent: the close after a kill runs it again.
      const teardown = (): void => {
        clearTimeout(helloTimer);
        leavePreAuth();
        authed.delete(socket);
        channels.closeAll();
        // A superseded socket must not evict its replacement, so the
        // per-device entry is dropped only while it still names THIS
        // socket, mirroring the DO. The authed identity lives on the
        // context.
        const id = ctx?.callerDeviceId;
        if (id !== undefined && authedByDevice.get(id)?.socket === socket) {
          authedByDevice.delete(id);
        }
        // ctx.signal is connection scoped: one controller per socket,
        // aborted exactly here (or in kill, which is idempotent with
        // this cleanup).
        controller.abort();
      };

      // End THIS connection now: no frame it delivers after this runs
      // a handler (dead), its in-flight handlers unwind (the abort),
      // and it is out of every map before the close frame even
      // flushes. Registered on the per-device entry so supersede and
      // the roster close reach it, satisfying closeThenTerminate's
      // precondition that the caller sets its dead flag first.
      const kill = (code: number, reason: string): void => {
        if (dead) return;
        dead = true;
        teardown();
        closeThenTerminate(socket, code, reason);
      };

      socket.on("close", teardown);
      socket.on("error", (error) => {
        console.warn(`[socket] connection error: ${errorMessageOf(error)}`);
      });
      socket.on("message", (data, isBinary) => {
        // The hello path awaits the proof check. A frame that throws
        // kills its own connection, never the host process.
        void handleMessage(data, isBinary).catch((error) => {
          console.warn(
            `[socket] dropping connection after a failed frame: ${errorMessageOf(error)}`,
          );
          kill(CLOSE_GOING_AWAY, "internal error");
        });
      });

      async function handleMessage(
        data: RawData,
        isBinary: boolean,
      ): Promise<void> {
        if (dead) return;
        const alive = authed.get(socket);
        if (alive !== undefined) alive.lastInboundAt = Date.now();
        // Binary frames are byte-channel frames, and only an authed
        // peer has channels: pre-hello, a binary frame is a malformed
        // hello. One naming no attached channel (late, after a reset)
        // is dropped, throttled.
        if (isBinary && ctx !== null) {
          // Bytes never pass through dispatch, so the grant is
          // re-read here: every open was grant-gated, and a grant
          // revoked since (the host turning peer commands off) drops
          // every channel on the connection the moment the peer
          // sends anything on one. Credit frames flow back during any
          // transfer, so a live stream notices within a window.
          if (ctx.isCallerCommandGranted?.() !== true) {
            channels.dropAll();
            return;
          }
          if (!channels.handleFrame(toBytes(data))) warnUnknownChannelFrame();
          return;
        }
        const frame = isBinary
          ? null
          : decodeFrame(toText(data), ClientFrameSchema);
        if (ctx === null) {
          if (frame === null || frame.t !== "hello") {
            kill(CLOSE_HELLO_FAILED, "malformed hello");
            return;
          }
          if (helloSeen) {
            kill(CLOSE_HELLO_FAILED, "duplicate hello");
            return;
          }
          helloSeen = true;
          // The host never receives a ticket, only a proof of holding
          // one, and a hello that carries no proof proves nothing.
          const hostProof = await answerProof(
            auth,
            hostNonce,
            arrivalKind,
            frame,
          );
          // The await yielded, so re-read the liveness flag a close or
          // a timeout may have set meanwhile.
          if (dead) return;
          if (hostProof === null) {
            recordAuthFailure(ip);
            // The owner gets a real signal under a brute force attempt.
            console.warn(`[socket] CLOSE_AUTH_FAILED: bad proof from ${ip}`);
            kill(CLOSE_AUTH_FAILED, "auth failed");
            return;
          }
          clearTimeout(helloTimer);
          failedAuth.delete(ip);
          leavePreAuth();
          // Bound to this socket only, so a handler streaming progress
          // reaches its caller rather than every peer. Push delivery
          // is subject to backpressure.
          const notifier: HandlerContext["notifier"] =
            (module, key) => (payload) => {
              const { channel, parsed } = resolveBroadcast(
                module,
                key,
                payload,
              );
              sendPushText(
                socket,
                encodeFrame({ t: "push", channel, payload: parsed }),
              );
            };
          // The ticket bound this hello to a deviceId, so the context
          // carries the authenticated peer identity and the host's
          // command-access answer, read live from the injected
          // predicate so a toggle applies without a reconnect.
          const callerDeviceId = frame.deviceId;
          ctx = {
            signal: controller.signal,
            isCallerCommandGranted: () => auth.isCommandGranted(),
            callerDeviceId,
            notifier,
            channels,
          };
          // A device dials at most one direct socket to a given peer,
          // so a duplicate authed connection from the same deviceId
          // supersedes the older one, like the DO does for its own
          // sockets. The old connection is KILLED, not just closed:
          // kill sets its dead flag and aborts its signal, so nothing
          // it delivers during the close grace window executes, and no
          // push reaches it either.
          authedByDevice
            .get(callerDeviceId)
            ?.kill(CLOSE_GOING_AWAY, "superseded");
          authedByDevice.set(callerDeviceId, { socket, kill });
          authed.set(socket, {
            lastInboundAt: Date.now(),
            heartbeats: false,
            kill,
          });
          if (frame.deflate === true && arrivalKind === "tunnel") {
            deflatingWriters.set(socket, createDeflatingWriter(socket));
            console.info(
              `[socket] deflating large frames for ${frame.deviceId} (tunnel-borne)`,
            );
          }
          send(socket, {
            t: "welcome",
            deviceId: opts.deviceId,
            appVersion: opts.appVersion,
            proof: hostProof,
          });
          return;
        }
        // The client's liveness ping (frames.ts): answer it, and note
        // that this peer heartbeats so the sweep may judge it.
        if (frame !== null && frame.t === "ping") {
          if (alive !== undefined) alive.heartbeats = true;
          send(socket, { t: "pong" });
          return;
        }
        // Past hello, a bad frame is dropped rather than fatal: one
        // malformed message must not kill a connection carrying other
        // in-flight calls.
        if (frame === null || frame.t !== "req") {
          console.warn("[socket] dropping unparseable frame");
          return;
        }
        if (inFlight >= MAX_IN_FLIGHT_PER_PEER) {
          send(socket, resError(frame.id, "too many in-flight requests"));
          return;
        }
        inFlight += 1;
        void dispatch(socket, ctx, frame, generation).finally(() => {
          inFlight -= 1;
        });
      }
    });
  }

  function startNow(opts: WsServerStartOpts): Promise<number> {
    return new Promise((resolve, reject) => {
      if (listener !== null) {
        reject(new Error("[socket] listener already started"));
        return;
      }
      const generation = ++generationCounter;
      const wss = new WebSocketServer({
        host: opts.bindAddress,
        port: opts.port,
        // Bounds pre-auth buffering. Inbound frames (hello, req) are
        // tiny, so a small ceiling costs nothing and denies a hostile
        // peer a large buffer. Outbound frames are unaffected.
        maxPayload: MAX_INBOUND_FRAME_BYTES,
        // Origin gate: no Origin (node and main-process clients), a
        // loopback http origin, or the configured web origin passes,
        // anything else is refused. See isAllowedOrigin for why this is
        // a coarse pre-filter and the hello's proof is the real auth. A
        // refusal logs (throttled) with the rejected origin, because
        // the likeliest cause is a web client reaching a desktop that
        // never set SM_ACCOUNT_WEB_ORIGIN, and without the log the web
        // dial dies as a bare refusal with no clue on either side.
        verifyClient: (info: { req: IncomingMessage }) => {
          const origin = info.req.headers.origin;
          const allowed = isAllowedOrigin(origin, opts.allowedOrigin);
          if (!allowed) {
            const at = Date.now();
            if (at - originRejectLoggedAt >= ORIGIN_REJECT_LOG_THROTTLE_MS) {
              originRejectLoggedAt = at;
              console.warn(
                `[socket] refusing direct upgrade from origin ${origin}` +
                  " (not an admitted origin; a web client needs" +
                  " SM_ACCOUNT_WEB_ORIGIN set to its exact origin on this" +
                  " device)",
              );
            }
          }
          return allowed;
        },
      });
      attach(wss, opts, generation);
      const onBindError = (error: Error) => {
        wss.close();
        status = {
          listening: false,
          port: null,
          bindAddress: opts.bindAddress,
          error: errorMessageOf(error),
        };
        console.error(
          `[socket] bind failed on ${opts.bindAddress}:${opts.port}: ${errorMessageOf(error)}`,
        );
        reject(error);
      };
      wss.once("error", onBindError);
      wss.once("listening", () => {
        wss.removeListener("error", onBindError);
        // Post-bind errors must not become crashing 'error' events, and
        // must surface rather than vanish.
        wss.on("error", (error) => {
          status = { ...status, error: errorMessageOf(error) };
          console.warn(`[socket] server error: ${errorMessageOf(error)}`);
        });
        listener = { wss, opts, generation };
        // The liveness sweep, one timer per LIVE listener (armed here,
        // after the bind, so a failed bind leaks none): a peer that
        // proved it heartbeats and then fell silent past the timeout
        // is killed like a roster drop. Quarter-period cadence keeps
        // the worst-case delay past the timeout small without a busy
        // loop.
        const livenessTimeoutMs =
          opts.livenessTimeoutMs ?? HOST_LIVENESS_TIMEOUT_MS;
        livenessTimer = setInterval(
          () => {
            const now = Date.now();
            for (const entry of authed.values()) {
              if (
                entry.heartbeats &&
                now - entry.lastInboundAt > livenessTimeoutMs
              ) {
                entry.kill(CLOSE_GOING_AWAY, "heartbeat timeout");
              }
            }
          },
          Math.max(50, Math.floor(livenessTimeoutMs / 4)),
        );
        livenessTimer.unref?.();
        const address = wss.address();
        const port =
          typeof address === "object" && address !== null
            ? address.port
            : opts.port;
        status = {
          listening: true,
          port,
          bindAddress: opts.bindAddress,
          error: null,
        };
        console.info(`[socket] listening on ${opts.bindAddress}:${port}`);
        resolve(port);
      });
    });
  }

  function stopNow(): Promise<void> {
    if (listener === null) return Promise.resolve();
    const { wss } = listener;
    // Drop the listener and clear the authed set first: a peer that
    // keeps sending during the grace window fails the dispatch
    // generation guard, and no push can reach a peer under a stopped or
    // rotated listener.
    listener = null;
    authed.clear();
    authedByDevice.clear();
    if (livenessTimer !== null) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
    status = { listening: false, port: null, bindAddress: null, error: null };
    for (const socket of wss.clients) {
      socket.close(CLOSE_GOING_AWAY, "server stopping");
    }
    // close() is advisory. Arm a short grace, then terminate any peer
    // that did not close, so a non-cooperating peer cannot wedge the
    // lifecycle queue or keep executing under a stopped listener.
    const graceTimer = setTimeout(() => {
      for (const socket of wss.clients) socket.terminate();
    }, TERMINATE_GRACE_MS);
    return new Promise((resolve) => {
      wss.close(() => {
        clearTimeout(graceTimer);
        resolve();
      });
    });
  }

  function sameListener(opts: WsServerStartOpts): boolean {
    if (listener === null) return false;
    const current = listener.opts;
    // deviceId and appVersion are process constants, so port,
    // bindAddress and accountId are the fields a config write or an
    // account switch can change under us. accountId is an identity
    // field: a switch must restart the listener so every socket authed
    // under the old account drops.
    return (
      current.port === opts.port &&
      current.bindAddress === opts.bindAddress &&
      current.accountId === opts.accountId &&
      // Env-derived and process-constant in practice, compared anyway
      // so a changed gate can never silently keep the old one.
      current.allowedOrigin === opts.allowedOrigin
    );
  }

  return {
    handle(channel, fn, opts) {
      // Mirrors ipcMain.handle's one-handler-per-channel rule, so a
      // double registration fails at boot on both wires alike.
      if (handlers.has(channel)) {
        throw new Error(
          `[socket] handler already registered for channel "${channel}"`,
        );
      }
      handlers.set(channel, fn);
      // Record an EXPLICITLY read-only channel (mutating:false) so
      // dispatch may serve it ungated. Fail-closed: a channel left
      // untagged, or tagged mutating:true, is deliberately NOT
      // recorded, so dispatch serves it only under the command-access
      // switch.
      if (opts?.mutating === false) readOnlyChannels.add(channel);
    },
    // Payloads arrive already parsed from the shared fan-out path.
    // Encode once, then fan the identical text out to every authed
    // socket rather than re-stringifying per peer.
    broadcastAll(channel, payload) {
      // The steady state of an idle listener (up, nobody connected)
      // must not pay a stringify per broadcast.
      if (authed.size === 0) return;
      const text = encodeFrame({ t: "push", channel, payload });
      for (const socket of authed.keys()) sendPushText(socket, text);
    },
    closePeersNotIn(online) {
      // Deleting the visited entry (kill does) is fine under Map
      // iteration.
      const live = new Set(online);
      for (const [deviceId, peer] of authedByDevice) {
        if (!live.has(deviceId)) {
          peer.kill(CLOSE_GOING_AWAY, "no longer in the account roster");
        }
      }
    },
    start: (opts) => lifecycle(() => startNow(opts)),
    stop: () => lifecycle(() => stopNow()),
    refresh: (resolve) =>
      lifecycle(async () => {
        const opts = await resolve();
        if (opts !== null && sameListener(opts)) return;
        await stopNow();
        if (opts !== null) await startNow(opts);
      }),
    status: () => ({ ...status }),
  };
}
