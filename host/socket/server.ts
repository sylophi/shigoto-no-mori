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
// This file must stay Electron free (host:check). The Electron facts a
// listener needs (appVersion) arrive through start opts instead.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { errorMessageOf } from "@shared/errors";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_GOING_AWAY,
  CLOSE_HELLO_FAILED,
  CLOSE_OVER_CAPACITY,
  type ClientFrame,
  ClientFrameSchema,
  encodeFrame,
  HELLO_TIMEOUT_MS,
  MAX_INBOUND_FRAME_BYTES,
  type ReqFrame,
  type ServerFrame,
} from "@shared/ipc/socket/frames";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import { createLimiter } from "@host/lib/util/limit";

export type WsServerStartOpts = {
  port: number;
  // Where the listener binds. Loopback ("127.0.0.1") is the default the
  // config resolver picks. "0.0.0.0" only under the explicit LAN opt-in
  // (socketHost.lan). Kept as a resolved string so this module never
  // reads config.
  bindAddress: string;
  // Shared secret from the device config. Never empty: startNow throws
  // on an empty token, so an unset config can never degrade into an
  // accept-everything listener even if a caller forgets the gate.
  token: string;
  // The host root's id and the host app's version, echoed in the
  // welcome frame. appVersion is an Electron fact, so the caller
  // injects it here rather than this module importing electron.
  deviceId: string;
  appVersion: string;
  // Test seam. Real callers take the 10s default.
  helloTimeoutMs?: number;
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
};

// Total sockets (authed plus pending) the listener will hold. Over this
// a new connection is closed before any per-connection state is built.
const MAX_CONNECTIONS = 64;
// Un-welcomed sockets held at once. A separate, tighter cap so a flood
// of connections that never say hello cannot crowd out real peers.
const MAX_PREAUTH_CONNECTIONS = 16;
// Concurrent dispatched requests per socket. Over this a request is
// refused rather than spawning yet another git or CLI subprocess.
const MAX_IN_FLIGHT_PER_SOCKET = 32;
// Skip a push once a socket's outbound buffer passes this, so a stalled
// peer watching verbose output cannot grow main-process memory without
// bound. Pushes are recoverable refresh signals.
const PUSH_BUFFER_LIMIT_BYTES = 1 << 23;
// After a shutdown close, how long a non-cooperating peer has before it
// is terminated, so it cannot wedge the lifecycle queue for ~30s.
const TERMINATE_GRACE_MS = 1_500;
// Let a rejection's close frame flush before the socket is destroyed,
// so the peer sees the code. The dead flag already blocks any frame
// arriving in this gap, so correctness does not depend on the delay.
const REJECT_TERMINATE_DELAY_MS = 50;
// Wrong-token attempts from one IP before a lockout window starts, so a
// wrong token is not a free infinite retry loop.
const AUTH_FAILURE_LIMIT = 5;
const AUTH_LOCKOUT_MS = 30_000;

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

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

// Unconditional send for res and welcome frames: these are answers a
// caller is awaiting, so they are never dropped under backpressure.
function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(encodeFrame(frame));
}

function parseClientFrame(text: string): ClientFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ClientFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function createWsServerBinding(): WsServerBinding {
  const handlers = new Map<
    string,
    (ctx: HandlerContext, raw: unknown) => Promise<unknown>
  >();
  // Sockets past hello. broadcastAll fans out to exactly this set, so
  // an unauthenticated connection can never receive a push.
  const authed = new Set<WebSocket>();
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
  // Wrong-token attempts per remote IP, for lockout.
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
    if (entry.until > Date.now()) return true;
    // Lockout elapsed: forget so a later genuine attempt starts clean.
    if (entry.until !== 0) failedAuth.delete(ip);
    return false;
  }

  function recordAuthFailure(ip: string): void {
    const entry = failedAuth.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= AUTH_FAILURE_LIMIT) {
      entry.until = Date.now() + AUTH_LOCKOUT_MS;
    }
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
      const ip = req.socket.remoteAddress ?? "unknown";
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
        closeThenTerminate(socket, CLOSE_AUTH_FAILED, "temporarily locked out");
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

      socket.on("close", () => {
        clearTimeout(helloTimer);
        leavePreAuth();
        authed.delete(socket);
        // ctx.signal is connection scoped: one controller per socket,
        // aborted exactly here.
        controller.abort();
      });
      socket.on("error", (error) => {
        console.warn(`[socket] connection error: ${errorMessageOf(error)}`);
      });
      socket.on("message", (data, isBinary) => {
        if (dead) return;
        const frame = isBinary ? null : parseClientFrame(toText(data));
        if (ctx === null) {
          if (frame === null || frame.t !== "hello") {
            dead = true;
            clearTimeout(helloTimer);
            leavePreAuth();
            closeThenTerminate(socket, CLOSE_HELLO_FAILED, "malformed hello");
            return;
          }
          if (!tokenMatches(frame.token, opts.token)) {
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
          ctx = {
            signal: controller.signal,
            // Bound to this socket only, so a handler streaming
            // progress reaches its caller rather than every peer. Push
            // delivery is subject to backpressure.
            notifier: (module, key) => (payload) => {
              const { channel, parsed } = resolveBroadcast(
                module,
                key,
                payload,
              );
              sendPushText(
                socket,
                encodeFrame({ t: "push", channel, payload: parsed }),
              );
            },
          };
          authed.add(socket);
          send(socket, {
            t: "welcome",
            deviceId: opts.deviceId,
            appVersion: opts.appVersion,
          });
          return;
        }
        // Past hello, a bad frame is dropped rather than fatal: one
        // malformed message must not kill a connection carrying other
        // in-flight calls.
        if (frame === null || frame.t !== "req") {
          console.warn("[socket] dropping unparseable frame");
          return;
        }
        if (inFlight >= MAX_IN_FLIGHT_PER_SOCKET) {
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
      // token can never open a listener, whatever config said upstream.
      if (opts.token === "") {
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
        // Origin gate: browsers always send Origin on a websocket
        // handshake, the legitimate node and Electron clients never do.
        // Refusing any Origin-bearing upgrade closes cross-site
        // websocket hijacking from a drive-by page.
        verifyClient: (info: { req: IncomingMessage }) =>
          info.req.headers.origin === undefined,
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
    // deviceId and appVersion are process constants, so port, token and
    // bindAddress are the only fields a config write can change under us.
    return (
      current.port === opts.port &&
      current.token === opts.token &&
      current.bindAddress === opts.bindAddress
    );
  }

  return {
    handle(channel, fn) {
      // Mirrors ipcMain.handle's one-handler-per-channel rule, so a
      // double registration fails at boot on both wires alike.
      if (handlers.has(channel)) {
        throw new Error(
          `[socket] handler already registered for channel "${channel}"`,
        );
      }
      handlers.set(channel, fn);
    },
    // Payloads arrive already parsed from the shared fan-out path.
    // Encode once, then fan the identical text out to every authed
    // socket rather than re-stringifying per peer.
    broadcastAll(channel, payload) {
      const text = encodeFrame({ t: "push", channel, payload });
      for (const socket of authed) sendPushText(socket, text);
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
