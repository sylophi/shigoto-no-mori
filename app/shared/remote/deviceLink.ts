// The dialing side of the device link (link.ts): one socket to a peer's
// listener, an RpcClient over it, the handshake, and then the peer's
// calls as a ClientTransport, its pushes, and its byte channels. It
// runs in the host and, verbatim, in the web client, so its one platform
// dependency is the socket constructor it is handed.
//
// It owns exactly one socket. A link that drops stays dropped: the
// tickets are single use, so redials live one layer up in the direct
// keeper (shared/hub/directKeeper.ts), which is the single owner of
// retry.
import type { DeviceKind } from "@shigomori/contracts/modules/link";
import {
  errorMessageOf,
  isProtocolVersionMismatchError,
  LinkRefusedError,
} from "@shigomori/contracts/errors";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FiberSet from "effect/FiberSet";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Socket from "effect/socket/Socket";
import type * as Scope from "effect/Scope";
import type { ClientTransport, Link } from "@shared/ipc/transport";
import { type ChannelMux, createChannelMux } from "./channels";
import { watchLiveness } from "@shigomori/engine/liveness";
import {
  flatClient,
  newConnectionId,
  quietProtocol,
} from "@shigomori/engine/rpcClient";
import { linkTransport, rpcLink } from "./rpcTransport";
import { PING_INTERVAL_MS, PING_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./link";
import { LinkGroup } from "@shigomori/contracts/link";
import type { KeyPair } from "@shared/crypto/noise";
import { CLOSE_HANDSHAKE_FAILED, sealDialer } from "./sealedSocket";

// A dial that failed before the welcome. `blocked` is a refused ticket,
// the wrong machine answering, or a peer on another protocol version,
// which the dial race remembers and the hub supervisor keys on; the
// direct keeper retries it on its ladder like anything else (a socket
// that would not open, the host's temporary lockout, a slow host). `code` is the close code when a
// socket close ended it. `error` is the peer's own refusal, for a
// caller that shows it (a version mismatch).
export class RemoteConnectError extends Error {
  readonly code: number | null;
  readonly blocked: boolean;
  readonly refusal: Error | undefined;
  constructor(
    message: string,
    code: number | null,
    blocked: boolean,
    refusal?: Error,
  ) {
    super(message);
    this.name = "RemoteConnectError";
    this.code = code;
    this.blocked = blocked;
    this.refusal = refusal;
  }
}

// What a link is opened with: the browser's WebSocket, or the `ws`
// package in the host, which names the errno a failed dial died of where
// the platform global reports a bare 1006.
export type OpenClientSocket = (url: string) => Socket.WebSocketLike;

export type DeviceLinkOptions = {
  // ws:// or wss:// URL of the peer's listener.
  url: string;
  // The single-use connect ticket the socket opens with, or on the
  // loopback the host's token, which the hello carries.
  ticket: string;
  // This connection's id, which the host tells it apart by: the one
  // its ticket was asked for (shared/hub/directDial.ts). A fresh one
  // when not given.
  connectionId?: string;
  // A peer's link is sealed (sealedSocket.ts): this device's key pair,
  // and the key the hub's roster names for the peer. The loopback's is
  // not.
  seal?: { readonly localKey: KeyPair; readonly remoteKey: Uint8Array };
  appVersion: string;
  localDeviceId: string;
  // The peer this dial means to reach, which is this machine's own host
  // on the loopback.
  expectedDeviceId: string;
  // Every push the peer sends, by channel, decoded.
  onPush?: (channel: string, payload: unknown) => void;
  openSocket: OpenClientSocket;
  // How long the whole dial may take, the socket's open included.
  deadlineMs: number;
  // Test seam: the protocol version the hello claims. This build's.
  protocolVersion?: number;
  // What this device is (contracts' link.ts, DeviceKindSchema), which
  // decides whether a second link of its supersedes the first. A
  // desktop app unless said otherwise.
  deviceKind?: DeviceKind;
  // The calls the far end serves: a peer's device link (LinkGroup, the
  // default), or this machine's own host on the loopback
  // (LoopbackGroup), whose token stands in for the ticket.
  group?: typeof LinkGroup;
};

export type DeviceConnection = {
  transport: ClientTransport;
  // The port-forward engine and the mirror gateway attach their local
  // sockets here, under ids they mint, before opening the far end.
  channels: ChannelMux;
  close(): void;
  // Asks the peer to answer NOW, within PROBE_TIMEOUT_MS: on a wake from
  // sleep or a tab coming back, so a link that died meanwhile is found
  // out in seconds. One that fails it drops like any other. Nothing on
  // the loopback, whose host the shell's watchdog judges.
  probe(): void;
  remoteDeviceId: string;
  remoteAppVersion: string;
};

// A link dialed in the caller's scope: open, said hello on, and up
// until the scope closes or the link drops (`dropped`). `gate`, for a
// direct dial's race (shared/hub/directDial.ts), hears the socket open
// and holds the hello until it is let through: opening spends the
// candidate's own ticket and supersedes nothing, so the race opens
// every candidate at once, and the hello supersedes the device's older
// link on the host, so it says one at a time.
export type DialedDevice = Omit<DeviceConnection, "close"> & {
  // The link's Effect face, which `transport` is the Promise face of.
  readonly link: Link;
  // Settles when the link drops on its own.
  readonly dropped: Effect.Effect<void>;
};

export const dialDevice = (
  options: DeviceLinkOptions,
  gate?: {
    readonly opened: Deferred.Deferred<void, RemoteConnectError>;
    readonly helloAsked: Deferred.Deferred<void>;
  },
): Effect.Effect<DialedDevice, RemoteConnectError, Scope.Scope> => {
  const group = options.group ?? LinkGroup;
  // Whatever the platform said about why the socket failed (`ws` names
  // the errno), for the dial's failure message. The code over the
  // message: it is address-free, so six interfaces refusing the same
  // way read as one reason.
  let errorDetail = "";
  let closeCode: number | null = null;

  const connectError = (message: string, blocked = false, refusal?: Error) =>
    new RemoteConnectError(
      errorDetail === "" ? message : `${message} (${errorDetail})`,
      closeCode,
      blocked,
      refusal,
    );

  return Effect.gen(function* () {
    const ws = options.openSocket(options.url);

    ws.addEventListener("error", (event) => {
      const cause = (event as { error?: unknown }).error;
      const code =
        cause instanceof Error &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : "";
      const detail =
        code !== ""
          ? code
          : cause instanceof Error
            ? cause.message
            : typeof (event as { message?: unknown }).message === "string"
              ? (event as { message: string }).message
              : "";
      if (detail !== "") errorDetail = detail;
    });
    ws.addEventListener("close", (event) => {
      closeCode = event.code ?? null;
    });
    // Sealed after the listeners above, so the close code is known by
    // the time anything reading the sealed socket hears the close.
    const wire =
      options.seal === undefined
        ? ws
        : sealDialer(ws, { ticket: options.ticket, ...options.seal });
    // Open once the socket is, its handshake done where it is sealed.
    let socketOpened = false;
    ws.addEventListener("open", () => {
      socketOpened = true;
    });
    const open = yield* Deferred.make<void>();
    if (wire.readyState === 1) Deferred.doneUnsafe(open, Exit.void);
    else {
      wire.addEventListener(
        "open",
        () => Deferred.doneUnsafe(open, Exit.void),
        { once: true },
      );
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          ws.close(1000);
        } catch {
          // Already closing.
        }
      }),
    );
    const dropped = yield* Deferred.make<void>();
    const cuttable = cuttableSocket(wire);
    const socket = yield* Socket.fromWebSocket(
      Effect.succeed(cuttable.socket),
      {
        openTimeout: options.deadlineMs,
      },
    );
    // Pings keep the far end's slot alive (its HOST_LIVENESS_TIMEOUT_MS)
    // and judge nothing. A link to another machine is judged by
    // watchLiveness below, and the loopback's to this machine's own host
    // by nothing here: the shell's watchdog judges that host. One
    // socket, one ticket: a dropped link is the keeper's to redial.
    const socketProtocol = yield* quietProtocol(socket, {
      pingInterval: PING_INTERVAL_MS,
      hooks: {
        onConnect: Effect.void,
        onDisconnect: Deferred.succeed(dropped, undefined),
      },
    });
    // A frame this end cannot decode (one past LINK_MAX_FRAME_BYTES)
    // leaves the RPC client's parser unable to find the next, so every
    // later answer fails too while the socket stays up (effect 4.0.2's
    // makeProtocolSocket). The link drops instead, and is dialed again.
    const protocol = RpcClient.Protocol.of({
      ...socketProtocol,
      run: (clientId, write) =>
        socketProtocol.run(clientId, (message) =>
          Predicate.isTagged(message, "ClientProtocolError")
            ? Effect.andThen(
                write(message),
                Deferred.succeed(dropped, undefined),
              )
            : write(message),
        ),
    });
    const client = yield* flatClient(group, protocol);
    const call = (tag: string, payload: unknown) =>
      client(tag, payload) as Effect.Effect<unknown, unknown>;
    const runFork = yield* FiberSet.makeRuntime<never>();

    yield* Deferred.await(open).pipe(
      Effect.raceFirst(
        Deferred.await(dropped).pipe(
          Effect.andThen(Effect.fail("dropped" as const)),
        ),
      ),
      Effect.timeoutOrElse({
        duration: options.deadlineMs,
        orElse: () => Effect.fail("timeout" as const),
      }),
      // The host closing the handshake refused this socket's ticket or
      // key: blocked, like a refused hello. Anything else at that
      // address proved nothing.
      Effect.mapError(() =>
        closeCode === CLOSE_HANDSHAKE_FAILED
          ? connectError(
              "the peer refused the connect ticket",
              true,
              new LinkRefusedError(),
            )
          : connectError(
              options.seal === undefined || !socketOpened
                ? "the socket did not open"
                : "the peer did not complete the handshake",
            ),
      ),
    );
    if (gate !== undefined) {
      yield* Deferred.succeed(gate.opened, undefined);
      yield* Deferred.await(gate.helloAsked);
    }

    const welcome = (yield* call("link:hello", {
      deviceId: options.localDeviceId,
      deviceKind: options.deviceKind ?? "desktop",
      connectionId: options.connectionId ?? newConnectionId(),
      appVersion: options.appVersion,
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
      ...(options.seal === undefined ? { token: options.ticket } : {}),
    }).pipe(
      Effect.mapError((error) =>
        isProtocolVersionMismatchError(error)
          ? connectError(error.message, true, error)
          : error instanceof LinkRefusedError
            ? connectError("the peer refused the connect ticket", true, error)
            : connectError(`the hello failed: ${errorMessageOf(error)}`),
      ),
    )) as { deviceId: string; appVersion: string };

    const link = yield* rpcLink({
      client,
      group,
      onPush: options.onPush,
      // The loopback's dial, to this machine's own host.
      local: options.expectedDeviceId === options.localDeviceId,
    });

    // A round trip behind the subscriptions, so the link counts as open
    // only once the host hears it for its pushes: the host serves a
    // link's calls in the order they arrive.
    yield* call("link:ping", undefined).pipe(
      Effect.mapError(() => connectError("the peer did not answer the ping")),
    );
    const liveness =
      options.expectedDeviceId === options.localDeviceId
        ? { probe: () => {} }
        : yield* watchLiveness({
            ping: call("link:ping", undefined),
            heard: cuttable.heard,
            intervalMs: PING_INTERVAL_MS,
            timeoutMs: PING_TIMEOUT_MS,
            probeTimeoutMs: PROBE_TIMEOUT_MS,
            dead: Effect.sync(cuttable.cut),
          });

    const channels = createChannelMux({
      call: (tag, payload) => Effect.asVoid(call(tag, payload)),
      read: (channelId, seq) =>
        call("link:read", { channelId, seq }) as Effect.Effect<
          Uint8Array,
          unknown
        >,
      fork: (effect) => runFork(effect),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => channels.closeAll()));

    return {
      link,
      transport: linkTransport(link, runFork),
      channels,
      probe: liveness.probe,
      remoteDeviceId: welcome.deviceId,
      remoteAppVersion: welcome.appVersion,
      dropped: Deferred.await(dropped),
    };
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof RemoteConnectError
          ? error
          : connectError(`the link failed: ${errorMessageOf(error)}`),
      );
    }),
  );
};

// A socket as Effect reads it, with a cut that closes it for Effect at
// once, as its pinger's verdict did: the link's calls fail as a drop,
// and the link drops. The close handshake with a peer that stopped
// answering can take a browser a minute, so it is not waited on. Every
// other property is the socket's own, so Effect still sets its
// `binaryType` and pauses it. `heard` counts the frames that came.
function cuttableSocket(wire: Socket.WebSocketLike) {
  type Listener = (event: Socket.WebSocketEvent) => void;
  const closes = new Set<Listener>();
  let cut = false;
  let heard = 0;
  wire.addEventListener("message", () => {
    heard += 1;
  });
  const socket = new Proxy(wire, {
    get(target, key) {
      if (key === "readyState") return cut ? 3 : target.readyState;
      if (key === "addEventListener") {
        return (type: string, listener: Listener, options?: object) => {
          if (type === "close") closes.add(listener);
          target.addEventListener(type as "close", listener, options);
        };
      }
      if (key === "removeEventListener") {
        return (type: string, listener: Listener) => {
          if (type === "close") closes.delete(listener);
          target.removeEventListener(type as "close", listener);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: (target, key, value) => Reflect.set(target, key, value, target),
  });
  return {
    socket,
    heard: () => heard,
    cut: () => {
      if (cut) return;
      cut = true;
      for (const listener of closes) {
        wire.removeEventListener("close", listener);
        listener({ code: 1006, reason: "the peer stopped answering" });
      }
      closes.clear();
      try {
        wire.close(1000);
      } catch {
        // Already closing.
      }
    },
  };
}
