// The dialing side of the device link (link.ts): one socket to a peer's
// listener, an RpcClient over it, the handshake, and then the peer's
// calls as a ClientTransport, its pushes, and its byte channels. It
// runs in main and, verbatim, in the web client, so its one platform
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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import type { ClientTransport, Link } from "@shared/ipc/transport";
import { log } from "@shared/log";
import { type ChannelMux, createChannelMux } from "./channels";
import { type FlatClient, linkTransport, rpcLink } from "./rpcTransport";
import { PING_INTERVAL_MS, PING_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./link";
import { LinkGroup } from "@shigomori/contracts/link";
import {
  handshakeProof,
  newHandshakeNonce,
  proofsMatch,
} from "@shigomori/contracts/proof";

// A dial that failed before the welcome. `blocked` is the verdict the
// keeper and the hub supervisor key on: a refused ticket, the wrong
// machine answering, or a peer on another protocol version must never
// auto-retry, or a refusal turns into a hammering loop. Everything else
// (a socket that would not open, the host's temporary lockout, a slow
// host) is safe to back off and retry. `code` is the close code when a
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
// package in main, which names the errno a failed dial died of where
// the platform global reports a bare 1006.
export type OpenClientSocket = (url: string) => Socket.WebSocketLike;

export type DeviceLinkOptions = {
  // ws:// or wss:// URL of the peer's listener.
  url: string;
  // The single-use connect ticket. It never travels (proof.ts).
  ticket: string;
  appVersion: string;
  localDeviceId: string;
  // The peer this dial means to reach: a welcome from any other device
  // fails the handshake, so a dial that landed on the wrong machine is
  // never cached under the intended peer.
  expectedDeviceId: string;
  // Once, when an established link drops on its own. Never for an
  // owner close, never for a failed dial.
  onClose?: () => void;
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
  // out in seconds. One that fails it drops like any other.
  probe(): void;
  remoteDeviceId: string;
  remoteAppVersion: string;
};

// A dial in two steps. Opening is free: the challenge spends no ticket
// and supersedes nothing, so a dialer opens every candidate at once.
// The hello spends the ticket and, on the host, supersedes the device's
// older link, so the dialer says it on one candidate at a time.
export type PendingDeviceConnection = {
  // Settles once the peer answered the challenge, or failed to.
  whenOpen: Promise<void>;
  // Says hello and settles with the link. Idempotent.
  authenticate(): Promise<DeviceConnection>;
  // Closes without a hello, harmless to the host. After a successful
  // authenticate, this is an owner close.
  abandon(): void;
};

// A link dialed in the caller's scope: open, said hello on, and up
// until the scope closes or the link drops (`dropped`). `gate`, for
// openDevice's two steps, hears the challenge answered and holds the
// hello until it is let through.
type DialedDevice = Omit<DeviceConnection, "close"> & {
  // The link's Effect face, which `transport` is the Promise face of.
  readonly link: Link;
  // Settles when the link drops on its own.
  readonly dropped: Effect.Effect<void>;
};

export const dialDevice = (
  options: DeviceLinkOptions,
  gate?: {
    readonly opened: Deferred.Deferred<string, RemoteConnectError>;
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
    const socket = yield* Socket.fromWebSocket(Effect.succeed(ws), {
      openTimeout: options.deadlineMs,
    });
    const protocol = yield* RpcClient.makeProtocolSocket({
      pingInterval: PING_INTERVAL_MS,
      pingTimeout: PING_TIMEOUT_MS,
      // One socket, one ticket: a dropped link is the keeper's to redial.
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(
        Layer.mergeAll(
          RpcSerialization.layerSchemaBinary(),
          Layer.succeed(RpcClient.ConnectionHooks, {
            onConnect: Effect.void,
            onDisconnect: Deferred.succeed(dropped, undefined),
          }),
        ),
      ),
    );
    // The group is built from the contract's calls as they are listed,
    // so its client knows each call only as some call: one with a tag,
    // a payload and an Effect or a Stream back.
    // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
    const client = (yield* RpcClient.make(group, { flatten: true }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    )) as unknown as FlatClient;
    const call = (tag: string, payload: unknown) =>
      client(tag, payload) as Effect.Effect<unknown, unknown>;
    const runFork = yield* FiberSet.makeRuntime<never>();

    const hostNonce = yield* call("link:challenge", undefined).pipe(
      Effect.map((answer) => (answer as { nonce: string }).nonce),
      Effect.raceFirst(
        Deferred.await(dropped).pipe(
          Effect.andThen(Effect.fail("dropped" as const)),
        ),
      ),
      Effect.mapError(() =>
        connectError("the peer did not answer the challenge"),
      ),
    );
    if (gate !== undefined) {
      yield* Deferred.succeed(gate.opened, hostNonce);
      yield* Deferred.await(gate.helloAsked);
    }

    const clientNonce = newHandshakeNonce();
    const proof = yield* Effect.promise(() =>
      handshakeProof(options.ticket, "client", hostNonce, clientNonce),
    );
    const welcome = (yield* call("link:hello", {
      deviceId: options.localDeviceId,
      deviceKind: options.deviceKind ?? "desktop",
      connectionId: newConnectionId(),
      appVersion: options.appVersion,
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
      nonce: clientNonce,
      proof,
    }).pipe(
      Effect.mapError((error) =>
        isProtocolVersionMismatchError(error)
          ? connectError(error.message, true, error)
          : error instanceof LinkRefusedError
            ? connectError("the peer refused the connect ticket", true, error)
            : connectError(`the hello failed: ${errorMessageOf(error)}`),
      ),
    )) as { deviceId: string; appVersion: string; proof: string };
    const want = yield* Effect.promise(() =>
      handshakeProof(options.ticket, "host", hostNonce, clientNonce),
    );
    // An impostor squatting one address retires that candidate only,
    // so a bad proof is not a blocking verdict.
    if (!proofsMatch(welcome.proof, want)) {
      log.warn(
        `[link] welcome proof did not match the connect ticket (peer claimed ${welcome.deviceId} at ${options.url})`,
      );
      return yield* Effect.fail(
        connectError("the welcome proof did not match the connect ticket"),
      );
    }
    // The wrong machine answered (a stale address, a NAT surprise).
    // Redialing the same address cannot change who lives there.
    if (welcome.deviceId !== options.expectedDeviceId) {
      return yield* Effect.fail(
        connectError("welcome from an unexpected device", true),
      );
    }

    const link = yield* rpcLink({ client, group, onPush: options.onPush });

    // A round trip behind the subscriptions, so the link counts as open
    // only once the host hears it for its pushes: the host serves a
    // link's calls in the order they arrive.
    yield* call("link:ping", undefined).pipe(
      Effect.mapError(() => connectError("the peer did not answer the ping")),
    );

    const channels = createChannelMux({
      call: (tag, payload) => Effect.asVoid(call(tag, payload)),
      read: (channelId) =>
        client("link:read", { channelId }) as Stream.Stream<
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
      probe: () => {
        runFork(
          call("link:ping", undefined).pipe(
            Effect.timeout(PROBE_TIMEOUT_MS),
            Effect.catchCause(() => Deferred.succeed(dropped, undefined)),
          ),
        );
      },
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

export function openDevice(
  options: DeviceLinkOptions,
): PendingDeviceConnection {
  const opened = Deferred.makeUnsafe<string, RemoteConnectError>();
  const helloAsked = Deferred.makeUnsafe<void>();
  const welcomed = Deferred.makeUnsafe<DeviceConnection, RemoteConnectError>();
  let established = false;
  let ownerClosed = false;

  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const {
        dropped,
        link: _,
        ...dialed
      } = yield* dialDevice(options, {
        opened,
        helloAsked,
      });
      established = true;
      yield* Deferred.succeed(welcomed, { ...dialed, close });
      yield* dropped;
    }).pipe(
      Effect.scoped,
      Effect.catch((failed) =>
        Effect.andThen(
          Deferred.fail(opened, failed),
          Deferred.fail(welcomed, failed),
        ),
      ),
    ),
  );
  fiber.addObserver(() => {
    // The established link ended on its own: the keeper's redial signal.
    if (established && !ownerClosed) options.onClose?.();
    // A dial still waiting is answered.
    const closed = new RemoteConnectError("connection closed", null, false);
    Effect.runSync(
      Deferred.fail(opened, closed).pipe(
        Effect.andThen(Deferred.fail(welcomed, closed)),
      ),
    );
  });

  function close(): void {
    ownerClosed = true;
    Effect.runFork(Fiber.interrupt(fiber));
  }

  const whenOpen = Effect.runPromise(Deferred.await(opened)).then(() => {});
  whenOpen.catch(() => {});
  const connected = Effect.runPromise(Deferred.await(welcomed));
  connected.catch(() => {});

  return {
    whenOpen,
    authenticate() {
      Effect.runSync(Deferred.succeed(helloAsked, undefined));
      return connected;
    },
    abandon: close,
  };
}

// This connection's id, which the host tells it apart by: 16 random
// bytes as hex.
export function newConnectionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
