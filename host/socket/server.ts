// Websocket binding of the shared ServerTransport: the host side of
// remote hosting (v2 step 3, slice A). Registration and listening are
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
// READ-ONLY WIRE (v2 step 6, slice B): the LAN token has no grant
// model, so this binding enforces read-only at dispatch, fail-closed:
// only channels explicitly registered mutating:false are served, and
// anything else (a mutation, or an untagged channel) is refused with
// the shared command-refused code before its handler can run. Commands
// for a remote peer ride the host's command-access switch instead.
//
// DIRECT DATA PLANE (v2 step 10, slice A): the same binding, created
// with a WsServerTicketAuth, serves a SECOND instance for direct
// device-to-device data. It differs from the legacy LAN instance in
// auth (single-use connect tickets bound to the hello deviceId instead
// of the static token), in dispatch (mutating channels served under a
// live per-peer command grant instead of hardcoded read-only), and in
// peer tracking (one authed socket per deviceId with supersede). All
// the hardening above is shared between both instances.
//
// This file must stay Electron free (host:check). The Electron facts a
// listener needs (appVersion) arrive through start opts instead.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { errorMessageOf } from "@shared/errors";
import { rendererSchemeOrigins } from "@shared/rendererScheme.mts";
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
  PUSH_BUFFER_LIMIT_BYTES,
  type ReqFrame,
  type ServerFrame,
  TERMINATE_GRACE_MS,
} from "@shared/ipc/socket/frames";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import { createLimiter } from "@shared/util/limit";
import { toText } from "./rawData";

// Ticket-mode auth for the direct data plane (v2 step 10, slice A): a
// SECOND binding instance serves device-to-device data over direct
// sockets, brokered by short-lived single-use connect tickets minted
// over the device hub. Injected at binding creation so this module
// stays free of the ticket store and the grant store alike. Absent
// means the legacy LAN behavior: static-token auth and the read-only
// dispatch gate, unchanged.
export type WsServerTicketAuth = {
  // Verifies the connect ticket presented in hello.token against the
  // claimed hello deviceId. The implementation must consume the ticket
  // on first presentation regardless of outcome (single use).
  verifyTicket(ticket: string, deviceId: string): boolean;
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
  // Extra exact-match Origin the upgrade gate admits (v2 step 10,
  // slice B): the configured web client's origin, so a browser dial
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
  // the given roster. Presence scopes the data plane (v2 step 10): the
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
  if (!ticketMode || !isLoopbackAddress(address)) return address;
  const forwarded = cfConnectingIp?.trim() ?? "";
  return forwarded === "" ? address : forwarded;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// Compare fixed-length digests so neither the token length nor a
// content prefix leaks through a short-circuit or through timing. An
// empty token on either side never matches: the accept-everything
// degradation is rejected here at the boundary too.
function tokenMatches(given: string, expected: string): boolean {
  if (given === "" || expected === "") return false;
  return timingSafeEqual(digest(given), digest(expected));
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
// listener (v2 step 10, slice B) may additionally admit ONE configured
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

// Unconditional send for res and welcome frames: these are answers a
// caller is awaiting, so they are never dropped under backpressure.
function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(encodeFrame(frame));
}

export function createWsServerBinding(
  auth?: WsServerTicketAuth,
): WsServerBinding {
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
  // Ticket mode only: the one authed peer per deviceId. A device dials
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
  // Wrong-token attempts per client identity (clientIdentityOf), for
  // lockout.
  const failedAuth = new Map<string, { count: number; until: number }>();
  let status: WsServerStatus = {
    listening: false,
    port: null,
    bindAddress: null,
    error: null,
  };
  // Serializes start/stop/refresh so a fast settings double-toggle
  // cannot interleave one refresh's stop with another's start.
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
    socket.send(text);
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
      send(socket, {
        t: "res",
        id: frame.id,
        ok: false,
        message: "listener no longer active",
      });
      return;
    }
    const fn = handlers.get(frame.channel);
    if (fn === undefined) {
      // Client-scoped and non-remote host channels are never registered
      // on this binding (main/ipc/register.ts withholds them), so this
      // is also the answer a remote peer gets for them.
      send(socket, {
        t: "res",
        id: frame.id,
        ok: false,
        message: `No handler registered for channel "${frame.channel}"`,
      });
      return;
    }
    if (!readOnlyChannels.has(frame.channel)) {
      // Fail-closed gate on anything not proven a read (explicitly
      // registered mutating:false). Legacy mode: the LAN wire has no
      // grant model, so a mutation or an untagged channel is always
      // refused BEFORE its handler runs. Ticket mode (the direct data
      // plane): mirror the hub link's dispatch and consult the
      // injected command-access switch LIVE at each call, never cached
      // on the session, so flipping it takes effect without a
      // reconnect. Either refusal carries the typed code so the client
      // transport surfaces "that machine will not run commands from
      // here" distinctly from a real failure. The session's context
      // already carries the live verdict, so dispatch asks it rather
      // than re-deriving from the auth seam.
      if (ctx.isCallerCommandGranted?.() !== true) {
        send(socket, {
          t: "res",
          id: frame.id,
          ok: false,
          code: COMMAND_REFUSED_CODE,
          message: COMMAND_REFUSED_MESSAGE,
        });
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
      send(socket, {
        t: "res",
        id: frame.id,
        ok: false,
        message: errorMessageOf(error),
      });
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
      const ip = clientIdentityOf(
        req.socket.remoteAddress,
        Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor,
        auth !== undefined,
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
      // that is answered only with a close code: this listener may sit
      // on an open LAN port, so pre-auth traffic gets nothing else.
      let ctx: HandlerContext | null = null;
      let inFlight = 0;
      const controller = new AbortController();

      const helloTimer = setTimeout(() => {
        // A hello arriving after this fires must not authenticate.
        dead = true;
        leavePreAuth();
        closeThenTerminate(socket, CLOSE_HELLO_FAILED, "hello timeout");
      }, helloTimeoutMs);

      // End THIS connection now: no frame it delivers after this runs
      // a handler (dead), its in-flight handlers unwind (the abort),
      // and it is out of every map before the close frame even
      // flushes. Registered on the per-device entry so supersede and
      // the roster close reach it, satisfying closeThenTerminate's
      // precondition that the caller sets its dead flag first.
      const kill = (code: number, reason: string): void => {
        if (dead) return;
        dead = true;
        clearTimeout(helloTimer);
        leavePreAuth();
        authed.delete(socket);
        const id = ctx?.callerDeviceId;
        if (id !== undefined && authedByDevice.get(id)?.socket === socket) {
          authedByDevice.delete(id);
        }
        controller.abort();
        closeThenTerminate(socket, code, reason);
      };

      socket.on("close", () => {
        clearTimeout(helloTimer);
        leavePreAuth();
        authed.delete(socket);
        // A superseded socket must not evict its replacement, so the
        // per-device entry is dropped only while it still names THIS
        // socket, mirroring the DO. The authed identity lives on the
        // context, ticket mode only.
        const id = ctx?.callerDeviceId;
        if (id !== undefined && authedByDevice.get(id)?.socket === socket) {
          authedByDevice.delete(id);
        }
        // ctx.signal is connection scoped: one controller per socket,
        // aborted exactly here (or in kill, which is idempotent with
        // this cleanup).
        controller.abort();
      });
      socket.on("error", (error) => {
        console.warn(`[socket] connection error: ${errorMessageOf(error)}`);
      });
      socket.on("message", (data, isBinary) => {
        if (dead) return;
        const frame = isBinary
          ? null
          : decodeFrame(toText(data), ClientFrameSchema);
        const alive = authed.get(socket);
        if (alive !== undefined) alive.lastInboundAt = Date.now();
        if (ctx === null) {
          if (frame === null || frame.t !== "hello") {
            dead = true;
            clearTimeout(helloTimer);
            leavePreAuth();
            closeThenTerminate(socket, CLOSE_HELLO_FAILED, "malformed hello");
            return;
          }
          // Legacy mode compares the static token. Ticket mode hands
          // hello.token to the injected verifier as a connect ticket
          // bound to the claimed hello deviceId, which the verifier
          // consumes single-use regardless of outcome. Both failures
          // take the same lockout-counted auth path.
          const authenticated =
            auth === undefined
              ? tokenMatches(frame.token, opts.token)
              : auth.verifyTicket(frame.token, frame.deviceId);
          if (!authenticated) {
            dead = true;
            clearTimeout(helloTimer);
            leavePreAuth();
            recordAuthFailure(ip);
            // The owner gets a real signal under a brute force attempt.
            console.warn(`[socket] CLOSE_AUTH_FAILED: bad token from ${ip}`);
            closeThenTerminate(socket, CLOSE_AUTH_FAILED, "auth failed");
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
              auth === undefined ? () => false : () => auth.isCommandGranted(),
            callerDeviceId,
            notifier,
          };
          if (callerDeviceId !== undefined) {
            // A device dials at most one direct socket to a given
            // peer, so a duplicate authed connection from the same
            // deviceId supersedes the older one, like the DO does for
            // its own sockets. The old connection is KILLED, not just
            // closed: kill sets its dead flag and aborts its signal,
            // so nothing it delivers during the close grace window
            // executes, and no push reaches it either.
            authedByDevice
              .get(callerDeviceId)
              ?.kill(CLOSE_GOING_AWAY, "superseded");
            authedByDevice.set(callerDeviceId, { socket, kill });
          }
          authed.set(socket, {
            lastInboundAt: Date.now(),
            heartbeats: false,
            kill,
          });
          send(socket, {
            t: "welcome",
            deviceId: opts.deviceId,
            appVersion: opts.appVersion,
          });
          return;
        }
        // The client's liveness ping (frames.ts): answer it, and note
        // that this peer heartbeats so the sweep may judge it. A pong
        // (the answer to a probe we never send) is simply alive.
        if (frame !== null && frame.t === "ping") {
          if (alive !== undefined) alive.heartbeats = true;
          send(socket, { t: "pong" });
          return;
        }
        if (frame !== null && frame.t === "pong") return;
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
        if (inFlight >= MAX_IN_FLIGHT_PER_PEER) {
          send(socket, {
            t: "res",
            id: frame.id,
            ok: false,
            message: "too many in-flight requests",
          });
          return;
        }
        inFlight += 1;
        void dispatch(socket, ctx, frame, generation).finally(() => {
          inFlight -= 1;
        });
      });
    });
  }

  function startNow(opts: WsServerStartOpts): Promise<number> {
    return new Promise((resolve, reject) => {
      if (listener !== null) {
        reject(new Error("[socket] listener already started"));
        return;
      }
      // The invariant, enforced where WsServerBinding owns it: an empty
      // token can never open a legacy listener, whatever config said
      // upstream. Ticket mode has no static token at all (the injected
      // verifier is the auth), so the guard does not apply there.
      if (auth === undefined && opts.token === "") {
        reject(new Error("[socket] refusing to start with an empty token"));
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
      // The liveness sweep, one timer per listener: a peer that proved it
      // heartbeats and then fell silent past the timeout is killed like a
      // roster drop. Quarter-period cadence keeps the worst-case delay
      // past the timeout small without a busy loop.
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
      for (const socket of authed.keys()) sendPushText(socket, text);
    },
    closePeersNotIn(online) {
      // Deleting the visited entry (kill does) is fine under Map
      // iteration. Ticket mode only in practice: the legacy wire never
      // populates authedByDevice.
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
