// Browser-side client transport for the websocket host binding (v2
// step 3, slice B). It is the renderer's ClientTransport onto a remote
// device AND, verbatim, the step-8 web client's transport, so it must
// use only browser-global APIs: no electron, no node. The global
// WebSocket is the one platform dependency. Node 22+ ships that same
// global, which is what lets the browser-only transport run under node
// in the durable proof.
//
// It speaks the frames.ts contract: one JSON object per text frame,
// hello first, then req/res correlated by a monotonic id, with push
// frames fanned out to local subscribers. It owns exactly one socket.
// Reconnect and backoff live one layer up in the supervisor, which is
// the single owner of retry.
import { errorMessageOf } from "@shared/errors";
import {
  CLOSE_AUTH_FAILED,
  COMMAND_REFUSED_CODE,
  CommandRefusedError,
  decodeFrame,
  encodeFrame,
  HELLO_TIMEOUT_MS,
  ServerFrameSchema,
} from "@shared/ipc/socket/frames";
import {
  createHeartbeat,
  type HeartbeatOptions,
} from "@shared/ipc/socket/heartbeat";
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
import { type ChannelMux, createChannelMux } from "@shared/ipc/socket/channels";
import type { ClientTransport } from "@shared/ipc/transport";

// A connect attempt failed before the welcome landed. `code` is the
// close code when the failure came from a socket close (null on a
// welcome timeout or a pre-open error). `blocked` is the block-vs-retry
// verdict the supervisor keys on: a wrong credential (CLOSE_AUTH_FAILED)
// must never auto-retry, or a typo turns into a hammering loop.
// Everything else is safe to back off and retry, INCLUDING the host's
// failed-auth lockout (CLOSE_AUTH_LOCKED_OUT), which is a temporary
// bench keyed on client IP rather than a verdict on our credential.
export class RemoteConnectError extends Error {
  readonly code: number | null;
  readonly blocked: boolean;
  constructor(message: string, code: number | null, blocked: boolean) {
    super(message);
    this.name = "RemoteConnectError";
    this.code = code;
    this.blocked = blocked;
  }
}

// The socket closed while invokes were in flight (or an invoke was made
// after close). Every pending invoke rejects with this so a caller sees
// a disconnect distinctly from a handler error. Message text stays
// generic: the shared/errors.ts matchers key on host handler messages,
// which this is not.
export class RemoteDisconnectedError extends Error {
  readonly code: number | null;
  constructor(code: number | null) {
    super("remote device disconnected");
    this.name = "RemoteDisconnectedError";
    this.code = code;
  }
}

// The socket surface openDevice drives, structurally: exactly the
// browser WebSocket API this file always used (the four events through
// addEventListener, a string send, readyState) and nothing more, so
// the platform global satisfies it unchanged. A node owner may inject
// the `ws` package's WebSocket instead, which implements this same
// surface. The reason to: Node's global WebSocket (undici) reports
// every connect failure as an empty TypeError followed by a bare 1006
// close, so a refused port, an unroutable address and a permission
// block all read identically, while `ws` names the errno
// (ECONNREFUSED, EHOSTUNREACH, ETIMEDOUT), which is the one fact that
// tells "wrong network" from "the OS is blocking local network access".
export type ClientSocket = {
  // A string is a JSON frame; bytes are a binary channel frame
  // (shared/ipc/socket/channels.ts). Both the browser global and the
  // `ws` package send a Uint8Array as a binary message.
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: { message?: string; error?: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number }) => void,
  ): void;
};
export type OpenClientSocket = (url: string) => ClientSocket;

const openGlobalSocket: OpenClientSocket = (url) => new WebSocket(url);

export type ConnectDeviceOptions = {
  // ws:// URL of the host listener.
  url: string;
  // Shared secret from the device config, sent in the hello frame.
  token: string;
  // This client build's version, carried in the hello so the host can
  // log or gate skew later.
  appVersion: string;
  // This client's device id, carried in the hello.
  localDeviceId: string;
  // Called once when an ESTABLISHED connection closes (after welcome).
  // A pre-welcome close rejects the connect promise instead, so this
  // fires at most once and never for a failed attempt.
  onClose: (code: number | null) => void;
  // Identity pin for the direct data plane (v2 step 10, slice A): when
  // set and the welcome's self-asserted deviceId differs, the
  // handshake fails and the socket closes, so a dial that landed on
  // the wrong machine can never be cached under the intended peer.
  // Absent for the legacy LAN dial, whose caller keys on whatever the
  // welcome says.
  expectedDeviceId?: string;
  // Wildcard push tap, fired for EVERY push frame before the
  // per-channel subscribers, so a bridge can forward this connection's
  // pushes wholesale (the device hub peerPush path) without enumerating
  // channels. A throw here is contained, mirroring the hub link's
  // onPeerPush.
  onAnyPush?: (channel: string, payload: unknown) => void;
  // The socket constructor, defaulting to the platform global. See
  // ClientSocket for why a node owner injects `ws` here.
  openSocket?: OpenClientSocket;
  // Test seam. Real callers take the frames.ts default.
  helloTimeoutMs?: number;
  // Test seams for the liveness heartbeat (shared/ipc/socket/heartbeat.ts).
  heartbeat?: HeartbeatOptions;
};

export type DeviceConnection = {
  transport: ClientTransport;
  // Byte channels on this socket (shared/ipc/socket/channels.ts): the
  // port-forward engine and the mirror gateway attach their local
  // sockets here, under ids they mint, before opening the far end.
  channels: ChannelMux;
  close(): void;
  // Ask the host to prove it is still there NOW, with the short probe
  // verdict window instead of the heartbeat cadence: fired on a wake
  // from sleep or a tab coming back, when a socket that died while we
  // were away should be found out in seconds, not at the next
  // heartbeat tick. A socket that fails the probe closes and reports
  // through onClose exactly like a heartbeat death.
  probe(): void;
  remoteDeviceId: string;
  remoteAppVersion: string;
};

// The two-phase handle the direct dialer's serialized-hello race needs
// (v2 step 10, slice B): open the socket now, present the credential
// later. A hello consumes a single-use connect ticket AND, on the
// host, supersedes any previous authed socket from the same device, so
// a race that hellos on every candidate at once would have the slower
// candidate kill the winner's fresh session. Opening is free and
// concurrent, and authenticate() is what spends the ticket.
export type PendingDeviceConnection = {
  // Resolves when the socket opens (the earliest a hello could be
  // sent), rejects when it closes or errors before opening. Observing
  // it is optional: an ignored rejection is absorbed internally.
  whenOpen: Promise<void>;
  // Sends the hello (immediately when the socket is open, on open
  // otherwise) and settles with the established connection or the
  // handshake failure. Idempotent: repeat calls return the same
  // promise without a second hello.
  authenticate(): Promise<DeviceConnection>;
  // Whether the hello frame was actually handed to the socket. The
  // dialer's blocked-verdict rule keys on this: only a hello that was
  // sent can have consumed its ticket, so a connection-time rejection
  // (a lockout, a dead route) must not read as a spent credential.
  helloSent(): boolean;
  // Close without authenticating. Harmless to the host: no hello was
  // presented, so no ticket was spent and no session was superseded.
  // After a successful authenticate, this is an owner close.
  abandon(): void;
};

// The block-vs-retry verdict for a close code. An ALLOWLIST of the
// codes that block, so a code this build has never heard of is
// retryable by default rather than terminal by accident. Only a wrong
// credential blocks: the supervisor must not spin on it. The lockout
// (CLOSE_AUTH_LOCKED_OUT) deliberately does NOT block -- it is
// temporary, it is keyed on client IP so it may have nothing to do
// with us, and a refused connection does not extend its window, so
// backing off through it is exactly right. That distinction can only
// be made by the code on the wire: this side cannot infer it, and the
// dialer's helloSent predicate never could (it records that we WROTE
// a hello, not that the host READ one). Kept here beside the connect
// logic so the one rule has a single owner.
function isBlockingCloseCode(code: number | null): boolean {
  return code === CLOSE_AUTH_FAILED;
}

// The single-phase connect every non-racing caller uses (the LAN
// supervisor, the hub peer dial helpers): open and hello in one
// motion, the behavior this function always had.
export function connectDevice(
  options: ConnectDeviceOptions,
): Promise<DeviceConnection> {
  return openDevice(options).authenticate();
}

export function openDevice(
  options: ConnectDeviceOptions,
): PendingDeviceConnection {
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;

  let resolve!: (connection: DeviceConnection) => void;
  let reject!: (error: unknown) => void;
  const connectPromise = new Promise<DeviceConnection>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An abandoned handle may never call authenticate, so nobody would
  // observe the rejection. The absorber keeps that from surfacing as
  // an unhandled rejection. authenticate() still returns the original
  // promise, whose rejection reaches its caller.
  connectPromise.catch(() => {});

  let resolveOpen!: () => void;
  let rejectOpen!: (error: unknown) => void;
  const whenOpen = new Promise<void>((res, rej) => {
    resolveOpen = res;
    rejectOpen = rej;
  });
  whenOpen.catch(() => {});

  const socket = (options.openSocket ?? openGlobalSocket)(options.url);

  // Correlation state for invokes on this socket.
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  // Push subscribers, purely local: fed by push frames, never touching
  // the wire. The shared registry owns the add/remove/fan-out and
  // isolates a throwing subscriber.
  const subscribers = createSubscriberRegistry("socket");
  // Byte channels, fed by binary frames and sending binary frames,
  // beside the JSON traffic on the same socket.
  const channels = createChannelMux({
    send: (frame) => {
      if (closed) throw new Error("socket closed");
      socket.send(frame);
    },
  });
  let unknownChannelFrames = 0;

  // Flips true the instant this socket is unusable (closed or errored),
  // so an invoke after close rejects immediately rather than hanging.
  let closed = false;
  // Throttle counter for the onAnyPush containment below, mirroring
  // the subscriber registry's throttled warn: a throwing tap on a
  // chatty push stream must not warn once per frame.
  let anyPushThrew = 0;
  // Set when the owner tears the connection down via close(), so the
  // ensuing close event stays silent: onClose must fire only for a
  // socket that dropped on its own, never for a deliberate teardown,
  // or the supervisor would schedule a reconnect against its own stop.
  let ownerClosed = false;
  // Non-null once the welcome landed. Distinguishes a pre-welcome
  // close (reject the connect promise) from a post-welcome close
  // (invoke onClose, reject pending).
  let welcome: { remoteDeviceId: string; remoteAppVersion: string } | null =
    null;
  // The two-phase hello state: requested by authenticate(), sent once
  // the socket is open too. connectDevice requests it up front, so the
  // single-phase path hellos on open exactly as before.
  let opened = false;
  let helloRequested = false;
  let helloWasSent = false;

  const sendHello = (): void => {
    if (helloWasSent || closed) return;
    helloWasSent = true;
    // Hello must be the first frame, within the host's hello timeout.
    socket.send(
      encodeFrame({
        t: "hello",
        token: options.token,
        deviceId: options.localDeviceId,
        appVersion: options.appVersion,
      }),
    );
  };

  // Armed at open time, not authenticate time, so the one timer bounds
  // the whole attempt (TCP open included) exactly as it always did. A
  // deferred authenticate (the dialer queueing behind another hello)
  // spends its wait against the same budget, which is the deadline the
  // dialer already passes in.
  const helloTimer = setTimeout(() => {
    if (welcome !== null || closed) return;
    // The welcome never arrived in time. A retryable failure: the host
    // may just be slow or mid-restart.
    closed = true;
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    const timeout = new RemoteConnectError("welcome timeout", null, false);
    rejectOpen(timeout);
    reject(timeout);
  }, helloTimeoutMs);

  // Reject every in-flight invoke with a disconnect error. Called once
  // on a post-welcome close, so a caller awaiting a res is never left
  // hanging.
  const rejectAllPending = (code: number | null): void => {
    const error = new RemoteDisconnectedError(code);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    // The byte channels die with the socket too: every attached
    // endpoint sees a reset.
    channels.closeAll();
  };

  // Liveness (shared/ipc/socket/heartbeat.ts), armed after the welcome.
  // A death is reported exactly like a socket close (pending rejected,
  // onClose fired) so the supervisor or keeper redials on it.
  const heartbeat = createHeartbeat({
    ...options.heartbeat,
    sendPing: () => socket.send(encodeFrame({ t: "ping" })),
    onDead: () => {
      if (closed) return;
      // The owner teardown (which also silences the platform close
      // that follows, so the death is reported exactly once, here).
      close();
      options.onClose(null);
    },
  });

  socket.addEventListener("open", () => {
    if (closed) return;
    opened = true;
    resolveOpen();
    if (helloRequested) sendHello();
  });

  socket.addEventListener("message", (event) => {
    if (closed) return;
    // A binary frame is a byte-channel frame (channels.ts), routed to
    // the attached channel; one that names no channel (a late frame
    // after a reset) is dropped. Anything else non-text (a browser
    // Blob, which no owner asks for) is dropped too. Either way the
    // host proved itself alive.
    if (typeof event.data !== "string") {
      heartbeat.noteInbound();
      const bytes =
        event.data instanceof Uint8Array
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : null;
      if (bytes === null || !channels.handleFrame(bytes)) {
        unknownChannelFrames += 1;
        if (unknownChannelFrames % 50 === 1) {
          console.warn(
            `[socket] dropping a binary frame for no attached channel (dropped ${unknownChannelFrames} so far)`,
          );
        }
      }
      return;
    }
    const frame = decodeFrame(event.data, ServerFrameSchema);
    if (frame === null) {
      // A malformed inbound frame is logged and dropped, never fatal:
      // one bad message must not kill a socket carrying live invokes.
      console.warn("[socket] dropping unparseable server frame");
      return;
    }
    // Every parseable frame proves the host alive, whatever it carries.
    heartbeat.noteInbound();

    if (welcome === null) {
      // Before the welcome, the only frame we act on is the welcome.
      // Anything else pre-welcome is dropped: the host sends nothing
      // else before it.
      if (frame.t !== "welcome") {
        console.warn("[socket] dropping pre-welcome frame");
        return;
      }
      if (
        options.expectedDeviceId !== undefined &&
        frame.deviceId !== options.expectedDeviceId
      ) {
        // The wrong machine answered (a stale address, a NAT
        // surprise). Blocked, not retryable: redialing the same
        // address cannot change who lives there, so the caller
        // surfaces the failure instead of caching the wrong host.
        closed = true;
        clearTimeout(helloTimer);
        try {
          socket.close();
        } catch {
          // Already closing.
        }
        reject(
          new RemoteConnectError(
            "welcome from an unexpected device",
            null,
            true,
          ),
        );
        return;
      }
      clearTimeout(helloTimer);
      welcome = {
        remoteDeviceId: frame.deviceId,
        remoteAppVersion: frame.appVersion,
      };
      heartbeat.start();
      resolve({
        transport,
        channels,
        close,
        probe: heartbeat.probe,
        remoteDeviceId: welcome.remoteDeviceId,
        remoteAppVersion: welcome.remoteAppVersion,
      });
      return;
    }

    if (frame.t === "pong") return;

    if (frame.t === "res") {
      const entry = pending.get(frame.id);
      if (entry === undefined) {
        // A res for an id we no longer track (already rejected on
        // close, or a duplicate). Nothing to route it to.
        return;
      }
      pending.delete(frame.id);
      if (frame.ok) {
        entry.resolve(frame.result);
      } else if (frame.code === COMMAND_REFUSED_CODE) {
        // The host's gate refused the command (the LAN wire is
        // read-only). Typed, message preserved, so a caller can
        // distinguish "that machine will not run commands from here"
        // from a real handler failure. An old host sends no code and
        // falls through to the plain Error below.
        entry.reject(new CommandRefusedError(frame.message));
      } else {
        // A plain Error carrying the host's message text, so the
        // shared/errors.ts matchers degrade a remote handler failure
        // exactly as they do an Electron IPC one.
        entry.reject(new Error(frame.message));
      }
      return;
    }

    if (frame.t === "push") {
      if (options.onAnyPush !== undefined) {
        // The wildcard tap sees every push before the per-channel
        // fan-out. Contained so a throwing bridge callback cannot
        // starve local subscribers, mirroring the hub link.
        try {
          options.onAnyPush(frame.channel, frame.payload);
        } catch (error) {
          anyPushThrew += 1;
          if (anyPushThrew % 50 === 1) {
            console.warn(
              `[socket] onAnyPush threw: ${errorMessageOf(error)} (threw ${anyPushThrew} so far)`,
            );
          }
        }
      }
      subscribers.emit(frame.channel, frame.payload);
      return;
    }

    // A second welcome, or any other frame after welcome, is not part
    // of the contract. Drop it.
    console.warn("[socket] dropping unexpected server frame");
  });

  // Whatever the platform said about WHY the socket failed, when it
  // said anything: the browser and Node's global fire error with no
  // detail, `ws` hands over the system error. Folded into the
  // pre-welcome close's message below, since the close is what settles
  // the attempt. The errno CODE is preferred over the message because
  // it is address-free ("ECONNREFUSED", where the message would be
  // "connect ECONNREFUSED 192.168.1.5:7431"): the dialer groups
  // candidates by reason, and six interface addresses refusing the
  // same way must read as one reason, not six.
  let errorDetail = "";
  socket.addEventListener("error", (event) => {
    // The error event is always followed by close, so the close
    // handler owns the outcome and the reject reason carries the close
    // code. Only the detail is kept here.
    const cause = event.error;
    const code =
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : "";
    const detail =
      code !== ""
        ? code
        : typeof event.message === "string" && event.message !== ""
          ? event.message
          : cause instanceof Error
            ? cause.message
            : "";
    if (detail !== "") errorDetail = detail;
  });

  socket.addEventListener("close", (event) => {
    clearTimeout(helloTimer);
    heartbeat.stop();
    // The owner tore this connection down (or the heartbeat already
    // declared and reported the death). close() already rejected any
    // pending invokes, so stay silent: no onClose, and reject the
    // connect promise only if it never resolved.
    if (ownerClosed) {
      const error = new RemoteConnectError("connection closed", null, false);
      if (!opened) rejectOpen(error);
      if (welcome === null) reject(error);
      return;
    }
    // The welcome-timeout path already closed the socket and rejected.
    if (closed && welcome === null) return;
    const wasWelcomed = welcome !== null;
    closed = true;
    if (!wasWelcomed) {
      // Closed before the handshake finished. The close code decides
      // block vs retry, and the supervisor reads it off the error.
      const code = event.code;
      const error = new RemoteConnectError(
        `connection closed before welcome (code ${code}${
          errorDetail === "" ? "" : `, ${errorDetail}`
        })`,
        code,
        isBlockingCloseCode(code),
      );
      if (!opened) rejectOpen(error);
      reject(error);
      return;
    }
    // An established connection dropped. Fail every pending invoke,
    // then hand the close code to the owner so it can decide reconnect.
    rejectAllPending(event.code);
    options.onClose(event.code);
  });

  const transport: ClientTransport = {
    invoke(channel: string, input: unknown): Promise<unknown> {
      if (closed) {
        // Invoke-after-close rejects immediately rather than queueing
        // onto a dead socket.
        return Promise.reject(new RemoteDisconnectedError(null));
      }
      const id = nextId++;
      return new Promise<unknown>((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        // Omit input when undefined so a void contract input rides as
        // an absent field, matching the host's parse of the wire.
        const frame =
          input === undefined
            ? ({ t: "req", id, channel } as const)
            : ({ t: "req", id, channel, input } as const);
        try {
          socket.send(encodeFrame(frame));
        } catch (error) {
          pending.delete(id);
          rej(error);
        }
      });
    },
    subscribe(
      channel: string,
      handler: (payload: unknown) => void,
    ): () => void {
      return subscribers.subscribe(channel, handler);
    },
  };

  function close(): void {
    if (closed) return;
    closed = true;
    ownerClosed = true;
    clearTimeout(helloTimer);
    heartbeat.stop();
    rejectAllPending(null);
    try {
      socket.close();
    } catch {
      // Already closing.
    }
  }

  return {
    whenOpen,
    authenticate() {
      if (!helloRequested) {
        helloRequested = true;
        if (opened && !closed) sendHello();
      }
      return connectPromise;
    },
    helloSent: () => helloWasSent,
    abandon: close,
  };
}
