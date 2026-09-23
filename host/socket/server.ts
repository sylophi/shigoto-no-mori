// Websocket binding of the shared ServerTransport: the host side of
// remote hosting. Registration and listening are
// decoupled on purpose: main/ipc/register.ts records every REMOTE host
// handler here at boot whether or not the device config ever enables
// the listener, so flipping the setting later only starts the socket.
//
// This listener may sit on an open LAN port, so it is written to be
// hostile-safe by default: loopback bind unless LAN is opted in, a
// small inbound frame cap, an Origin gate, connection and in-flight
// caps, failed-auth lockout, backpressure on pushes, and hard
// termination (not advisory close) on every rejection and shutdown.
//
// READ-ONLY WIRE: the LAN token has no grant
// model, so this binding enforces read-only at dispatch, fail-closed:
// only channels explicitly registered mutating:false are served, and
// anything else (a mutation, or an untagged channel) is refused with
// the shared command-refused code before its handler can run. Commands
// for a remote peer ride the host's command-access switch instead.
//
// DIRECT DATA PLANE: the same binding, created
// with a WsServerTicketAuth, serves a SECOND instance for direct
// device-to-device data. It differs from the legacy LAN instance in
// auth (single-use connect tickets bound to the hello deviceId instead
// of the static token), in dispatch (mutating channels served under a
// live per-peer command grant instead of hardcoded read-only), and in
// peer tracking (one authed socket per deviceId with supersede). All
// the hardening above is shared between both instances.
//
// LIFECYCLE: a listener is a resource in its own Effect scope (the
// server via acquireRelease, then its liveness sweep, a Schedule.spaced
// fiber), and every connection lives in a child scope of it whose close
// is the connection's end: out of every map, its context's signal
// aborted, its channels reset, its socket closed and terminated, its
// fibers (the hello deadline, the proof check, the deflating writer,
// the calls in flight) interrupted. Stopping or rotating a listener
// closes its scope, which ends every connection on it, so a peer left
// on an old listener can run nothing. start/stop/refresh stay queued in
// call order behind one limiter. The ws callbacks are the non-Effect
// edge: they fork onto the `runtime` seam, which a proof points at a
// TestClock.
//
// This file must stay Electron free (pnpm test host-boundary). The
// Electron facts a listener needs (appVersion) arrive through start
// opts instead.
import type { IncomingMessage } from "node:http";
import { deflateRaw } from "node:zlib";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Iterable,
  Queue,
  Schedule,
  Scope,
} from "effect";
import { WebSocket, WebSocketServer } from "ws";
import { errorMessageOf } from "@shared/errors";
import { secretsMatch } from "@host/lib/util/secretCompare";
import { rendererSchemeOrigins } from "@shared/packaging/rendererScheme.mts";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_AUTH_LOCKED_OUT,
  CLOSE_GOING_AWAY,
  CLOSE_HELLO_FAILED,
  CLOSE_OVER_CAPACITY,
  type ClientFrame,
  ClientFrameSchema,
  COMMAND_REFUSED_CODE,
  COMMAND_REFUSED_MESSAGE,
  decodeFrame,
  encodeFrame,
  HELLO_TIMEOUT_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  MAX_IN_FLIGHT_PER_PEER,
  MAX_INBOUND_FRAME_BYTES,
  PUSH_BUFFER_LIMIT_BYTES,
  type ReqFrame,
  type ServerFrame,
  TERMINATE_GRACE_MS,
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
  defaultSupervisorRuntime,
  type SupervisorRuntime,
} from "@shared/remote/supervisor";
import {
  createChannelMux,
  createUnknownChannelFrameWarner,
} from "@shared/ipc/socket/channels";
import type { RawData } from "ws";
import { toBytes, toText } from "./rawData";
import { encodeWireError } from "@shared/ipc/wireError";

// Ticket-mode auth for the direct data plane: a
// SECOND binding instance serves device-to-device data over direct
// sockets, brokered by short-lived single-use connect tickets minted
// over the device hub. Injected at binding creation so this module
// stays free of the ticket store and the grant store alike. Absent
// means the legacy LAN behavior: static-token auth and the read-only
// dispatch gate, unchanged.
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
  // Where the listener binds. Loopback ("127.0.0.1") is the default the
  // config resolver picks. "0.0.0.0" only under the explicit LAN opt-in
  // (socketHost.lan). The direct listener binds "::" (dual stack: both
  // families accept), because it advertises IPv6 candidates too and an
  // IPv4-only bind would make every one of them guaranteed dead. Kept
  // as a resolved string so this module never reads config.
  bindAddress: string;
  // Shared secret from the device config. Never empty: startNow throws
  // on an empty token, so an unset config can never degrade into an
  // accept-everything listener even if a caller forgets the gate.
  // Ignored in ticket mode (the injected verifier is the auth), where
  // callers pass "".
  token: string;
  // The host root's id and the host app's version, echoed in the
  // welcome frame. appVersion is an Electron fact, so the caller
  // injects it here rather than this module importing electron.
  deviceId: string;
  appVersion: string;
  // Ticket mode: the account the listener serves. An IDENTITY field,
  // compared in sameListener, so an account switch restarts the
  // listener and drops every authed socket from the old account
  // instead of leaving them live under the new one. The legacy LAN
  // listener has no account and leaves it unset.
  accountId?: string;
  // Extra exact-match Origin the upgrade gate admits: the configured web client's origin, so a browser dial
  // arriving through the wss tunnel passes. Unset keeps the slice A
  // behavior (origin-less and app-local origins only).
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
  // Resolves with the bound port (meaningful when opts.port is 0 in
  // tests), rejects when the bind fails or the token is empty. Rejects
  // when already started: reconciliation goes through refresh.
  start(opts: WsServerStartOpts): Promise<number>;
  stop(): Promise<void>;
  // Reconciles the listener with the wanted state. The resolver runs
  // INSIDE the serialized lifecycle so the config read and the reconcile
  // are atomic: two overlapping refreshes cannot apply a stale config
  // last (a rotated token can never be silently reverted). It returns
  // null to stop, or opts to (re)start unless the running listener
  // already matches them.
  refresh(resolve: () => Promise<WsServerStartOpts | null>): Promise<void>;
  status(): WsServerStatus;
  // Ticket mode: kill the authed sockets whose peer deviceId is not in
  // the given roster. Presence scopes the data plane: the
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
// so the peer sees the code. A connection is dead to every frame
// arriving in this gap (its scope is closed), so correctness does not
// depend on the delay.
const REJECT_TERMINATE_DELAY_MS = 50;
// Wrong-token attempts from one client identity before a lockout
// window starts, so a wrong token is not a free infinite retry loop.
const AUTH_FAILURE_LIMIT = 5;
const AUTH_LOCKOUT_MS = 30_000;

// How often at most the ticket-mode listener logs a refused web
// Origin. A deployment whose desktop never set SM_ACCOUNT_WEB_ORIGIN
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

// The identity lockout, caps and log lines key on. The legacy LAN
// listener keys on the socket's remoteAddress untouched. The
// ticket-mode listener additionally serves connections arriving
// through the local cloudflared connector, which ALL land on loopback:
// keying those on remoteAddress would collapse every tunnel-borne
// client into one 127.0.0.1 bucket, letting 5 bad tickets from
// anywhere on the internet bench every tunnel dial for the lockout
// window, forever renewable. cloudflared forwards the real client
// address in CF-Connecting-IP, so a loopback connection in ticket mode
// keys on that header instead when present. Only loopback connections
// may delegate to the header: a LAN peer cannot spoof its way into
// another bucket because its remoteAddress is not loopback.
export function clientIdentityOf(
  remoteAddress: string | undefined,
  cfConnectingIp: string | undefined,
  ticketMode: boolean,
): string {
  const address = remoteAddress ?? "unknown";
  if (!ticketMode || !tunnelBorne(remoteAddress, cfConnectingIp)) {
    return address;
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

// Which advertised candidate a ticket-mode connection came in on, so a
// ticket can be held to the kind it was minted for.
export function arrivalKindOf(
  remoteAddress: string | undefined,
  cfConnectingIp: string | undefined,
): DirectCandidateKind {
  return tunnelBorne(remoteAddress, cfConnectingIp) ? "tunnel" : "lan";
}

// Ticket mode's hello check. Resolves the host's half of the mutual
// proof when the client proved one of its pending tickets, else null.
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
// hello token is what actually authenticates a peer (a bad token
// terminates the socket). Legitimate clients are node and main-process
// sockets, which send no Origin, plus the app's own renderer, whose
// browser-global WebSocket always sends one: the renderer-scheme
// origin (shigomori://app or shigomori-dev://app, both builds load
// over it, see main/electron/clerk.ts), or a loopback http origin from
// a locally served web client. Anything else is a drive-by browser
// page, refused before it can even attempt a hello. The direct
// listener may additionally admit ONE configured
// web-client origin, so the web client can dial wss tunnel URLs: the
// exact-match `allowedOrigin` arrives through start opts from the same
// SM_ACCOUNT_WEB_ORIGIN env the app's account layer reads, never
// hardcoded. The legacy LAN listener passes none and keeps its pinned
// behavior.
export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigin?: string,
): boolean {
  if (origin === undefined) return true;
  if (rendererSchemeOrigins().includes(origin)) return true;
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

// How one socket's frames go out: straight to the socket, or through
// the ordered deflating writer below.
type FrameWriter = (data: string | Uint8Array) => void;

// One connection as the binding's maps and the liveness sweep see it.
// Its lifetime is its scope (see serveConnection), so nothing here
// says whether it is still alive: kill ends it, and a connection that
// is gone is out of every map.
type Conn = {
  readonly socket: WebSocket;
  // Replaced by the deflating writer when a tunnel-borne hello asks.
  write: FrameWriter;
  // Liveness (HOST_LIVENESS_TIMEOUT_MS in frames.ts): when its last
  // frame arrived, and whether it has ever pinged (only a peer that
  // proved it heartbeats is judged, so an older client that never
  // pings is left alone).
  lastInboundAt: number;
  heartbeats: boolean;
  // Ends the connection now, see serveConnection.
  kill(code: number, reason: string): void;
};

// One bound listener: its start opts, the scope its server, its
// liveness sweep and every connection live in, and the clock the
// socket callbacks stamp liveness with (the runtime's, so a test on a
// TestClock moves it).
type Live = {
  readonly opts: WsServerStartOpts;
  readonly scope: Scope.Closeable;
  readonly clock: Clock.Clock;
};

type HelloFrame = Extract<ClientFrame, { t: "hello" }>;

type WsServerBindingDeps = {
  // Where the listener's fibers run. Real callers take Effect's default
  // services; a test passes a ManagedRuntime built on TestClock.layer()
  // and moves the hello deadline, the liveness sweep and the lockout
  // window with TestClock.adjust.
  runtime?: SupervisorRuntime;
};

const isClosed = (scope: Scope.Scope): boolean => scope.state._tag === "Closed";

// The text of a frame worth deflating, or null to send it as it is.
function deflatable(data: string | Uint8Array): string | null {
  return typeof data === "string" && data.length >= DEFLATE_MIN_TEXT_LENGTH
    ? data
    : null;
}

// The raw-deflate bytes of a frame's text, or null when it is not
// worth sending that way (it did not shrink, or zlib refused).
function deflated(text: string): Effect.Effect<Buffer | null> {
  return Effect.callback((resume) => {
    const raw = Buffer.from(text, "utf8");
    deflateRaw(raw, (error, bytes) => {
      resume(
        Effect.succeed(
          error === null && bytes.length + 1 < raw.length ? bytes : null,
        ),
      );
    });
  });
}

// The ordered writer of each socket the host deflates for
// (shared/ipc/socket/deflatedFrame.ts): a tunnel-borne connection whose
// hello asked. Every other socket writes straight out. A LAN peer is
// left alone on purpose: its link outruns the deflate, which would
// then be the slow part of a bundle transfer.
//
// Deflating is async (zlib's thread pool, so a megabyte of diff never
// blocks the host's loop), and a frame that finishes late must not be
// overtaken by the ones behind it: script output arrives as ordered
// pushes, and a channel's bytes keep their place among the JSON frames.
// So while a frame is queued or deflating every later frame of the
// socket queues behind it, drained in order by one fiber of the
// connection, and with none outstanding a frame that needs no
// deflating goes straight out and pays nothing.
const deflatingWriter = Effect.fnUntraced(function* (
  socket: WebSocket,
  tasks: FiberSet.FiberSet,
) {
  const frames = yield* Queue.unbounded<string | Uint8Array>();
  let queued = 0;
  const write = (data: string | Uint8Array): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  };
  const writeNext = Effect.gen(function* () {
    const data = yield* Queue.take(frames);
    const text = deflatable(data);
    const bytes = text === null ? null : yield* deflated(text);
    try {
      write(
        bytes === null ? data : Buffer.concat([DEFLATED_FRAME_PREFIX, bytes]),
      );
    } catch (error) {
      // A send that threw (the socket dying under it) loses this frame
      // only, not the ones queued behind it.
      console.warn(`[socket] queued send failed: ${errorMessageOf(error)}`);
    }
    queued -= 1;
  });
  yield* FiberSet.run(tasks, Effect.forever(writeNext));
  const writer: FrameWriter = (data) => {
    if (queued === 0 && deflatable(data) === null) {
      write(data);
      return;
    }
    queued += 1;
    Queue.offerUnsafe(frames, data);
  };
  return writer;
});

// Unconditional send for res and welcome frames: these are answers a
// caller is awaiting, so they are never dropped under backpressure.
function send(conn: Conn, frame: ServerFrame): void {
  if (conn.socket.readyState !== WebSocket.OPEN) return;
  conn.write(encodeFrame(frame));
}

// A failed call's answer: the message plus, for a typed error, its tag
// and fields (shared/ipc/wireError.ts), so the shared/errors.ts
// matchers behave the same on both wires.
function failedRes(id: ReqFrame["id"], error: unknown): ServerFrame {
  const encoded = encodeWireError(error);
  return {
    t: "res",
    id,
    ok: false,
    message: errorMessageOf(error),
    ...(encoded === undefined ? {} : { error: encoded }),
  };
}

// close() alone is advisory: ws keeps delivering inbound frames for up
// to ~30s. Send the close frame, then terminate after a short grace so
// the socket is truly gone, and so the peer sees the code first. The
// terminate is a fiber of the listener's scope: if the listener stops
// inside the grace, its own shutdown terminates the socket instead.
// Nothing is processed in the gap: a connection is dead the moment its
// scope closes, and a socket rejected before it had one never had a
// message handler.
function closeThenTerminate(
  live: Live,
  socket: WebSocket,
  code: number,
  reason: string,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    try {
      socket.close(code, reason);
    } catch {
      // Already closing.
    }
    return Effect.sleep(REJECT_TERMINATE_DELAY_MS).pipe(
      Effect.andThen(
        Effect.sync(() => {
          try {
            socket.terminate();
          } catch {
            // Already gone.
          }
        }),
      ),
      Effect.forkIn(live.scope),
      Effect.asVoid,
    );
  });
}

// The listener's shutdown, run when its scope closes: every client is
// sent the going-away close, and after a short grace any peer that did
// not close is terminated, so a non-cooperating peer cannot wedge the
// lifecycle queue. Done once the server has let go of every socket.
function closeServer(wss: WebSocketServer): Effect.Effect<void> {
  return Effect.suspend(() => {
    const closed = Deferred.makeUnsafe<void>();
    for (const socket of wss.clients) {
      socket.close(CLOSE_GOING_AWAY, "server stopping");
    }
    wss.close(() => {
      Deferred.doneUnsafe(closed, Effect.void);
    });
    return Deferred.await(closed).pipe(
      Effect.timeoutOrElse({
        duration: TERMINATE_GRACE_MS,
        orElse: () =>
          Effect.sync(() => {
            for (const socket of wss.clients) socket.terminate();
          }).pipe(Effect.andThen(Deferred.await(closed))),
      }),
    );
  });
}

// The ticket-mode command switch, read live at every call. A throw
// from the owner's predicate is contained and reads as not granted:
// the gate fails closed, and a socket callback never throws on it.
function commandGranted(ticketAuth: WsServerTicketAuth): boolean {
  try {
    return ticketAuth.isCommandGranted();
  } catch (error) {
    console.warn(`[socket] isCommandGranted threw: ${errorMessageOf(error)}`);
    return false;
  }
}

// A fiber's failure that is not its interruption, logged: a defect in
// a forked fiber is reported nowhere else.
function logFailure(what: string) {
  return (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.sync(() => {
          console.warn(`[socket] ${what}: ${Cause.pretty(cause)}`);
        });
}

export function createWsServerBinding(
  auth?: WsServerTicketAuth,
  deps: WsServerBindingDeps = {},
): WsServerBinding {
  const runtime = deps.runtime ?? defaultSupervisorRuntime;
  const handlers = new Map<
    string,
    (ctx: HandlerContext, raw: unknown) => Promise<unknown>
  >();
  // The channel names EXPLICITLY registered read-only (mutating:false),
  // collected fail-closed exactly like the hub binding's set: dispatch
  // serves a channel over this wire ONLY when it is in here, so a
  // mutation or an untagged channel is refused even though it is
  // registered. Registration stays unconditional (the Electron wire
  // serves everything); only the LAN dispatch consults this.
  const readOnlyChannels = new Set<string>();
  // Un-welcomed connections, for the pre-auth cap.
  const pending = new Set<Conn>();
  // Connections past hello. broadcastAll fans out to exactly this set,
  // so an unauthenticated connection can never receive a push, and the
  // listener's liveness sweep judges it so a dead client socket cannot
  // sit here until the OS notices.
  const authed = new Set<Conn>();
  // Ticket mode only: the one authed peer per deviceId. A device dials
  // at most one direct socket to a given peer, so a duplicate authed
  // connection from the same deviceId supersedes the older one,
  // mirroring the DO's behavior for its own sockets. Supersede and the
  // roster close KILL the old connection (its scope closes): a close
  // frame alone would let the old socket keep dispatching req frames
  // for the close grace window, and a mutating invoke could execute
  // twice.
  const authedByDevice = new Map<string, Conn>();
  // The binding's lifetime, the parent of every listener's scope. A
  // listener stops and starts again under it, so nothing closes it
  // today; it is what the app runtime's scope takes over once the
  // binding lives in a Layer (EFFECT-MIGRATION.md, Phase 2 step 7).
  const runnerScope = Scope.makeUnsafe();
  let listener: Live | null = null;
  let droppedPushes = 0;
  // Last time an Origin refusal was logged, for the throttle.
  let originRejectLoggedAt = Number.NEGATIVE_INFINITY;
  // Wrong-token attempts per client identity (clientIdentityOf), for
  // lockout. Times are the runtime clock's.
  const failedAuth = new Map<string, { count: number; until: number }>();
  let status: WsServerStatus = {
    listening: false,
    port: null,
    bindAddress: null,
    error: null,
  };
  // Serializes start/stop/refresh IN CALL ORDER, so a fast settings
  // double-toggle cannot interleave one refresh's stop with another's
  // start, and the last call made is the state that stands (an Effect
  // Semaphore hands its permit to whichever waiter the scheduler wakes
  // first, which is not that).
  const lifecycle = createLimiter(1);

  function isLockedOut(ip: string, now: number): boolean {
    const entry = failedAuth.get(ip);
    if (entry === undefined) return false;
    if (entry.until <= now) {
      // The window elapsed, whether the entry ever reached the limit or
      // not: forget it so a later genuine attempt starts clean.
      failedAuth.delete(ip);
      return false;
    }
    return entry.count >= AUTH_FAILURE_LIMIT;
  }

  function recordAuthFailure(ip: string, now: number): void {
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

  function sendPushText(conn: Conn, text: string): void {
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    if (conn.socket.bufferedAmount > PUSH_BUFFER_LIMIT_BYTES) {
      droppedPushes += 1;
      if (droppedPushes % 50 === 1) {
        console.warn(
          `[socket] dropping push under backpressure (dropped ${droppedPushes} so far)`,
        );
      }
      return;
    }
    conn.write(text);
  }

  // One call, as a fiber of its connection: the Promise handler runs to
  // its answer unless the connection ends first (its signal aborts and
  // this fiber is interrupted), in which case there is no one to
  // answer.
  const answer = (
    conn: Conn,
    ctx: HandlerContext,
    frame: ReqFrame,
    fn: (ctx: HandlerContext, raw: unknown) => Promise<unknown>,
  ): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => fn(ctx, frame.input),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((result) =>
        Effect.try({
          try: () => send(conn, { t: "res", id: frame.id, ok: true, result }),
          catch: (error) => error,
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => send(conn, failedRes(frame.id, error))),
      ),
      Effect.catchCause(logFailure("a call failed")),
    );

  // One accepted connection, from its first frame to its end, in its
  // own scope (a child of the listener's). The scope is the
  // connection's lifetime: closing it (kill, the socket's close, or the
  // listener stopping) takes the connection out of every map, aborts
  // its context's signal, resets its byte channels, closes the socket
  // (terminating it after a grace) and interrupts its fibers: the hello
  // deadline, the proof check, the deflating writer and every call in
  // flight. A closed scope is also how a late frame knows the
  // connection is dead, which covers the listener being stopped or
  // rotated under it: its scope is the listener's child.
  const serveConnection = (
    live: Live,
    socket: WebSocket,
    ip: string,
    arrivalKind: DirectCandidateKind,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const dead = (): boolean => isClosed(scope) || isClosed(live.scope);
      // The close the scope's finalizer sends: set by kill, null when
      // the socket closed on its own or the listener is stopping.
      let closing: { code: number; reason: string } | null = null;
      // Ends THIS connection now. closeUnsafe marks the scope closed in
      // this very turn, so no frame the socket delivers after this runs
      // anything, and on the default runtime the finalizer below has run
      // too (the connection is out of every map) before this returns.
      const end = (how: { code: number; reason: string } | null): void => {
        if (isClosed(scope)) return;
        closing = how;
        const finalize = Scope.closeUnsafe(scope, Exit.void);
        if (finalize !== undefined) runtime.runFork(finalize);
      };
      const conn: Conn = {
        socket,
        write: (data) => socket.send(data),
        lastInboundAt: 0,
        heartbeats: false,
        kill: (code, reason) => end({ code, reason }),
      };
      // Non-null once the hello handshake succeeded. Everything before
      // that is answered only with a close code: this listener may sit
      // on an open LAN port, so pre-auth traffic gets nothing else.
      let ctx: HandlerContext | null = null;
      // One hello per connection, latched before the proof check
      // awaits: two hellos racing through the await would otherwise
      // both see ctx === null and both authenticate.
      let helloSeen = false;
      const controller = new AbortController();
      // Byte channels on THIS socket (shared/ipc/socket/channels.ts):
      // binary frames route here, handlers attach far ends through the
      // context, and every endpoint is reset when the connection ends.
      const channels = createChannelMux({
        send: (frame) => {
          if (socket.readyState !== WebSocket.OPEN) {
            throw new Error("socket not open");
          }
          conn.write(frame);
        },
      });
      const warnUnknownChannelFrame = createUnknownChannelFrameWarner("socket");
      // The calls in flight (capped per peer), and the connection's own
      // fibers. Made before the finalizer below, so they are
      // interrupted after it has run.
      const calls = yield* FiberSet.make();
      const runCall = yield* FiberSet.runtime(calls)();
      const tasks = yield* FiberSet.make();
      const runTask = yield* FiberSet.runtime(tasks)();
      pending.add(conn);
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          pending.delete(conn);
          authed.delete(conn);
          // A superseded connection must not evict its replacement, so
          // the per-device entry is dropped only while it still names
          // THIS connection, mirroring the DO. The authed identity lives
          // on the context, ticket mode only.
          const id = ctx?.callerDeviceId;
          if (id !== undefined && authedByDevice.get(id) === conn) {
            authedByDevice.delete(id);
          }
          // ctx.signal is connection scoped: one controller per socket,
          // aborted exactly here.
          controller.abort();
          try {
            channels.closeAll();
          } catch (error) {
            console.warn(
              `[socket] resetting channels threw: ${errorMessageOf(error)}`,
            );
          }
          if (closing !== null) {
            return closeThenTerminate(
              live,
              socket,
              closing.code,
              closing.reason,
            );
          }
          // The listener stopping: its shutdown terminates the socket
          // after its own grace.
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(CLOSE_GOING_AWAY, "server stopping");
          }
          return Effect.void;
        }),
      );

      // Ticket mode opens the handshake: the client cannot hello until
      // it has this nonce. Not a secret, so it goes out pre-auth.
      const hostNonce = auth === undefined ? null : newHandshakeNonce();
      if (hostNonce !== null) {
        send(conn, { t: "challenge", nonce: hostNonce });
      }

      // The hello deadline, lifted by a good hello. A hello still being
      // checked when it passes is interrupted with the rest of the
      // connection, so it cannot authenticate after.
      const welcomed = Deferred.makeUnsafe<void>();
      runTask(
        Deferred.await(welcomed).pipe(
          Effect.timeoutOrElse({
            duration: live.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
            orElse: () =>
              Effect.sync(() => conn.kill(CLOSE_HELLO_FAILED, "hello timeout")),
          }),
        ),
      );

      // The hello's verdict. Legacy mode compares the static token,
      // synchronously. Ticket mode never receives a ticket, only a
      // proof of holding one, and a hello that carries no proof proves
      // nothing. Both failures take the same lockout-counted auth path.
      const authenticate = (frame: HelloFrame): Effect.Effect<void> =>
        Effect.gen(function* () {
          const hostProof =
            auth === undefined || hostNonce === null
              ? undefined
              : yield* Effect.tryPromise({
                  try: () => answerProof(auth, hostNonce, arrivalKind, frame),
                  catch: (error) => error,
                });
          // The proof check yielded: the connection may have ended
          // meanwhile, and a dead connection never authenticates.
          if (dead()) return;
          const now = yield* Clock.currentTimeMillis;
          const authenticated =
            auth === undefined
              ? secretsMatch(frame.token ?? "", live.opts.token)
              : typeof hostProof === "string";
          if (!authenticated) {
            recordAuthFailure(ip, now);
            // The owner gets a real signal under a brute force attempt.
            console.warn(`[socket] CLOSE_AUTH_FAILED: bad token from ${ip}`);
            conn.kill(CLOSE_AUTH_FAILED, "auth failed");
            return;
          }
          Deferred.doneUnsafe(welcomed, Effect.void);
          failedAuth.delete(ip);
          pending.delete(conn);
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
                conn,
                encodeFrame({ t: "push", channel, payload: parsed }),
              );
            };
          // Legacy wire: the static token proves nothing about
          // identity, so callerDeviceId stays undefined and the grant
          // predicate answers false without consulting any store (the
          // LAN wire is read-only by policy). Ticket mode: the ticket
          // bound this hello to a deviceId, so the context carries the
          // authenticated peer identity and the host's command-access
          // answer, read live from the injected predicate so a toggle
          // applies without a reconnect.
          const callerDeviceId =
            auth === undefined ? undefined : frame.deviceId;
          ctx = {
            signal: controller.signal,
            isCallerCommandGranted:
              auth === undefined ? () => false : () => commandGranted(auth),
            callerDeviceId,
            notifier,
            channels,
          };
          if (callerDeviceId !== undefined) {
            // A device dials at most one direct socket to a given
            // peer, so a duplicate authed connection from the same
            // deviceId supersedes the older one, like the DO does for
            // its own sockets. The old connection is KILLED, not just
            // closed: its scope closes, so nothing it delivers during
            // the close grace window executes, and no push reaches it
            // either.
            authedByDevice
              .get(callerDeviceId)
              ?.kill(CLOSE_GOING_AWAY, "superseded");
            authedByDevice.set(callerDeviceId, conn);
          }
          conn.lastInboundAt = now;
          authed.add(conn);
          if (frame.deflate === true && arrivalKind === "tunnel") {
            conn.write = yield* deflatingWriter(socket, tasks);
            console.info(
              `[socket] deflating large frames for ${frame.deviceId} (tunnel-borne)`,
            );
          }
          send(conn, {
            t: "welcome",
            deviceId: live.opts.deviceId,
            appVersion: live.opts.appVersion,
            proof: hostProof ?? undefined,
          });
        }).pipe(
          // A proof check that threw (the ticket seam included) ends its
          // own connection, never the host process.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.sync(() => {
                  console.warn(
                    `[socket] dropping connection after a failed frame: ${errorMessageOf(Cause.squash(cause))}`,
                  );
                  conn.kill(CLOSE_GOING_AWAY, "internal error");
                }),
          ),
        );

      const onMessage = (data: RawData, isBinary: boolean): void => {
        if (dead()) return;
        if (ctx !== null)
          conn.lastInboundAt = live.clock.currentTimeMillisUnsafe();
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
            conn.kill(CLOSE_HELLO_FAILED, "malformed hello");
            return;
          }
          if (helloSeen) {
            conn.kill(CLOSE_HELLO_FAILED, "duplicate hello");
            return;
          }
          helloSeen = true;
          runTask(authenticate(frame));
          return;
        }
        // The client's liveness ping (frames.ts): answer it, and note
        // that this peer heartbeats so the sweep may judge it.
        if (frame !== null && frame.t === "ping") {
          conn.heartbeats = true;
          send(conn, { t: "pong" });
          return;
        }
        // bye is a hub-wire frame (the device hub has no per-peer
        // socket close). This wire has a real socket close, so a bye
        // here is meaningless and silently ignored.
        if (frame !== null && frame.t === "bye") return;
        // Past hello, a bad frame is dropped rather than fatal: one
        // malformed message must not kill a connection carrying other
        // in-flight calls.
        if (frame === null || frame.t !== "req") {
          console.warn("[socket] dropping unparseable frame");
          return;
        }
        if (Iterable.size(calls) >= MAX_IN_FLIGHT_PER_PEER) {
          send(conn, {
            t: "res",
            id: frame.id,
            ok: false,
            message: "too many in-flight requests",
          });
          return;
        }
        const fn = handlers.get(frame.channel);
        if (fn === undefined) {
          // Client-scoped and non-remote host channels are never
          // registered on this binding (main/ipc/register.ts withholds
          // them), so this is also the answer a remote peer gets for
          // them.
          send(conn, {
            t: "res",
            id: frame.id,
            ok: false,
            message: `No handler registered for channel "${frame.channel}"`,
          });
          return;
        }
        // Fail-closed gate on anything not proven a read (explicitly
        // registered mutating:false). Legacy mode: the LAN wire has no
        // grant model, so a mutation or an untagged channel is always
        // refused BEFORE its handler runs. Ticket mode (the direct data
        // plane): mirror the hub link's dispatch and consult the
        // injected command-access switch LIVE at each call, never
        // cached on the session, so flipping it takes effect without a
        // reconnect. Either refusal carries the typed code so the
        // client transport surfaces "that machine will not run
        // commands from here" distinctly from a real failure. The
        // session's context already carries the live verdict, so
        // dispatch asks it rather than re-deriving from the auth seam.
        if (
          !readOnlyChannels.has(frame.channel) &&
          ctx.isCallerCommandGranted?.() !== true
        ) {
          send(conn, {
            t: "res",
            id: frame.id,
            ok: false,
            code: COMMAND_REFUSED_CODE,
            message: COMMAND_REFUSED_MESSAGE,
          });
          return;
        }
        // Started in this turn, so handlers run in the order their
        // frames arrived.
        runCall(answer(conn, ctx, frame, fn));
      };

      socket.on("close", () => end(null));
      socket.on("error", (error) => {
        console.warn(`[socket] connection error: ${errorMessageOf(error)}`);
      });
      socket.on("message", (data, isBinary) => {
        // A frame that throws kills its own connection, never the host
        // process.
        try {
          onMessage(data, isBinary);
        } catch (error) {
          console.warn(
            `[socket] dropping connection after a failed frame: ${errorMessageOf(error)}`,
          );
          conn.kill(CLOSE_GOING_AWAY, "internal error");
        }
      });
    });

  // A new socket on a live listener: the caps and the lockout first,
  // checked before any per-connection state is built, then the
  // connection in its own scope.
  const accept = (
    live: Live,
    socket: WebSocket,
    req: IncomingMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (isClosed(live.scope)) {
        // The listener is stopping and its shutdown has not yet closed
        // the server.
        socket.terminate();
        return;
      }
      const forwardedFor = req.headers["cf-connecting-ip"];
      const cfConnectingIp = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : forwardedFor;
      const ip = clientIdentityOf(
        req.socket.remoteAddress,
        cfConnectingIp,
        auth !== undefined,
      );
      const arrivalKind = arrivalKindOf(
        req.socket.remoteAddress,
        cfConnectingIp,
      );
      if (authed.size + pending.size >= MAX_CONNECTIONS) {
        return yield* closeThenTerminate(
          live,
          socket,
          CLOSE_OVER_CAPACITY,
          "over capacity",
        );
      }
      if (pending.size >= MAX_PREAUTH_CONNECTIONS) {
        return yield* closeThenTerminate(
          live,
          socket,
          CLOSE_OVER_CAPACITY,
          "too many pending connections",
        );
      }
      if (isLockedOut(ip, yield* Clock.currentTimeMillis)) {
        console.warn(`[socket] rejecting connection from locked-out ${ip}`);
        // A DISTINCT code from the bad-credential refusal, and the
        // distinction is load-bearing: this close happens before any
        // hello is read, so the client it refuses may hold a perfectly
        // good ticket and simply share an IP with whoever burned the
        // attempts. Only this side knows that. Sending AUTH_FAILED here
        // made a temporary, self-expiring bench look to the client
        // exactly like a refused credential, which the direct keeper
        // answers by parking with no timer -- so the lockout lifted
        // 30s later and nothing ever redialed.
        return yield* closeThenTerminate(
          live,
          socket,
          CLOSE_AUTH_LOCKED_OUT,
          "temporarily locked out",
        );
      }
      const scope = yield* Scope.fork(live.scope);
      yield* serveConnection(live, socket, ip, arrivalKind).pipe(
        Scope.provide(scope),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.warn(
            `[socket] dropping a connection that failed to set up: ${Cause.pretty(cause)}`,
          );
          socket.terminate();
        }),
      ),
    );

  // Binds the server, resolving once it listens. Registered on the
  // listener before the bind, so no connection can arrive unhandled.
  const bind = (live: Live): Effect.Effect<WebSocketServer, Error> =>
    Effect.callback((resume) => {
      const { opts, clock } = live;
      const wss = new WebSocketServer({
        host: opts.bindAddress,
        port: opts.port,
        // Bounds pre-auth buffering. Inbound frames (hello, req) are
        // tiny, so a small ceiling costs nothing and denies a hostile
        // peer a large buffer. Outbound frames are unaffected.
        maxPayload: MAX_INBOUND_FRAME_BYTES,
        // Origin gate: no Origin (node and main-process clients), one
        // of the app's own renderer origins, or the configured web
        // origin passes, anything else is refused. See isAllowedOrigin
        // for why this is a coarse pre-filter and the hello token is
        // the real auth. A ticket-mode refusal logs (throttled) with
        // the rejected origin, because the likeliest cause is a web
        // client reaching a desktop that never set
        // SM_ACCOUNT_WEB_ORIGIN, and without the log the web dial dies
        // as a bare refusal with no clue on either side.
        verifyClient: (info: { req: IncomingMessage }) => {
          const origin = info.req.headers.origin;
          const allowed = isAllowedOrigin(origin, opts.allowedOrigin);
          if (!allowed && auth !== undefined) {
            const at = clock.currentTimeMillisUnsafe();
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
      wss.on("connection", (socket, req) => {
        runtime.runFork(accept(live, socket, req));
      });
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
        resume(Effect.fail(error));
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
        resume(Effect.succeed(wss));
      });
    });

  // The liveness sweep: a peer that proved it heartbeats and then fell
  // silent past the timeout is killed like a roster drop.
  const sweepLiveness = (timeoutMs: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const conn of authed) {
        if (conn.heartbeats && now - conn.lastInboundAt > timeoutMs) {
          conn.kill(CLOSE_GOING_AWAY, "heartbeat timeout");
        }
      }
    });

  // One listener's resources, acquired into its scope: the server,
  // then its liveness sweep (armed after the bind, so a failed bind
  // leaves none). Closing the scope ends every connection first, then
  // the sweep, then shuts the server down.
  const listen = (live: Live): Effect.Effect<number, Error, Scope.Scope> =>
    Effect.gen(function* () {
      const wss = yield* Effect.acquireRelease(bind(live), closeServer);
      // Quarter-period cadence keeps the worst-case delay past the
      // timeout small without a busy loop.
      const livenessTimeoutMs =
        live.opts.livenessTimeoutMs ?? HOST_LIVENESS_TIMEOUT_MS;
      yield* Effect.forkScoped(
        Effect.repeat(
          sweepLiveness(livenessTimeoutMs),
          Schedule.spaced(Math.max(50, Math.floor(livenessTimeoutMs / 4))),
        ),
      );
      const address = wss.address();
      return typeof address === "object" && address !== null
        ? address.port
        : live.opts.port;
    });

  const startNow = (opts: WsServerStartOpts): Effect.Effect<number, Error> =>
    Effect.gen(function* () {
      if (listener !== null) {
        return yield* Effect.fail(
          new Error("[socket] listener already started"),
        );
      }
      // The invariant, enforced where WsServerBinding owns it: an empty
      // token can never open a legacy listener, whatever config said
      // upstream. Ticket mode has no static token at all (the injected
      // verifier is the auth), so the guard does not apply there.
      if (auth === undefined && opts.token === "") {
        return yield* Effect.fail(
          new Error("[socket] refusing to start with an empty token"),
        );
      }
      const live: Live = {
        opts,
        scope: yield* Scope.fork(runnerScope),
        clock: yield* Clock.Clock,
      };
      const port = yield* listen(live).pipe(
        Scope.provide(live.scope),
        Effect.onError(() => Scope.close(live.scope, Exit.void)),
      );
      listener = live;
      status = {
        listening: true,
        port,
        bindAddress: opts.bindAddress,
        error: null,
      };
      console.info(`[socket] listening on ${opts.bindAddress}:${port}`);
      return port;
    });

  const stopNow: Effect.Effect<void> = Effect.suspend(() => {
    const current = listener;
    if (current === null) return Effect.void;
    // Drop the listener and empty the maps first, in this turn: no push
    // can reach a peer under a stopped or rotated listener, and a peer
    // that keeps sending meanwhile is dead to it (its scope is a child
    // of the one closing here).
    listener = null;
    pending.clear();
    authed.clear();
    authedByDevice.clear();
    status = { listening: false, port: null, bindAddress: null, error: null };
    return Scope.close(current.scope, Exit.void);
  });

  function sameListener(opts: WsServerStartOpts): boolean {
    if (listener === null) return false;
    const current = listener.opts;
    // deviceId and appVersion are process constants, so port, token,
    // bindAddress and accountId are the fields a config write or an
    // account switch can change under us. accountId is an identity
    // field: a switch must restart the listener so every socket authed
    // under the old account drops.
    return (
      current.port === opts.port &&
      current.token === opts.token &&
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
      // dispatch may serve it over this wire. Fail-closed, mirroring
      // the hub binding: a channel left untagged, or tagged
      // mutating:true, is deliberately NOT recorded, so the read-only
      // gate refuses it.
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
      for (const conn of authed) sendPushText(conn, text);
    },
    closePeersNotIn(online) {
      // Deleting the visited entry (kill does) is fine under Map
      // iteration. Ticket mode only in practice: the legacy wire never
      // populates authedByDevice.
      const live = new Set(online);
      for (const [deviceId, conn] of authedByDevice) {
        if (!live.has(deviceId)) {
          conn.kill(CLOSE_GOING_AWAY, "no longer in the account roster");
        }
      }
    },
    start: (opts) => lifecycle(() => runtime.runPromise(startNow(opts))),
    stop: () => lifecycle(() => runtime.runPromise(stopNow)),
    // The resolver runs inside the call's turn in the queue, see the
    // type's comment.
    refresh: (resolve) =>
      lifecycle(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const opts = yield* Effect.tryPromise({
              try: () => resolve(),
              catch: (error) => error,
            });
            if (opts !== null && sameListener(opts)) return;
            yield* stopNow;
            if (opts !== null) yield* startNow(opts);
          }),
        ),
      ),
    status: () => ({ ...status }),
  };
}
