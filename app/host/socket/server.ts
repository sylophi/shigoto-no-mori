// The host side of the device link (shared/remote/link.ts): the
// listener another device dials, serving every contract call annotated
// `remote` over Effect RPC, the pushes as streams, and the byte
// channels. Registration and listening are apart on purpose:
// main/ipc/register.ts records every remote handler in the registrar at
// boot whether or not the device is enrolled, so signing in later only
// starts the listener.
//
// A peer's socket opens sealed (shared/remote/sealedSocket.ts): the
// ticket minted for it over the hub, checked before any crypto runs,
// then a Noise handshake proving it holds the key the hub's roster names
// for the device the ticket was minted for, and every frame after that
// encrypted. Its hello must name that device, whose key the roster must
// still hold, and this build's protocol version (modules/link.ts), and
// only that hello spends the ticket. Until then every other call is refused
// (PeerAuth). Then a call annotated gated:false runs for
// the peer, and any other only under the host's live command switch, or
// as a call the host itself invited (CommandGate). Above both sits the
// sharing switch: off, every call is refused that was not invited, reads
// included, and a push reaches a peer only where the host still lets it
// (SharingGate). A desktop device holds one link: a second hello from it
// supersedes the first (two app instances on one root). A web device
// holds one per connection its tabs dial, each with its own pushes and
// views. Either way a hello with a connection id already held replaces
// that connection, its own redial.
//
// The listener sits on every interface (and behind the tunnel), so it
// is written to be hostile-safe: an inbound frame cap, an Origin gate,
// connection and in-flight caps, a failed-auth lockout, and hard
// termination on every rejection and shutdown.
import type { DeviceKind } from "@shigomori/contracts/modules/link";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  annotation,
  callOf,
  channelOf,
  type ContractCall,
  Gated,
  isBroadcast,
  isInvoke,
  Remote,
} from "@shigomori/contracts/contract";
import {
  CommandRefusedError,
  type CallFailure,
  callFailureOf,
  errorMessageOf,
  LinkRefusedError,
  LinkUnauthenticatedError,
  NotSharingError,
  ProtocolVersionMismatchError,
  RemoteCallError,
} from "@shigomori/contracts/errors";
import type { DirectCandidateKind } from "@shigomori/contracts/modules/direct";
import { accountContract } from "@shigomori/contracts/modules/account";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import type { CallContext, EffectServerTransport } from "@shared/ipc/transport";
import { log } from "@shared/log";
import {
  CommandGate,
  LinkGroup,
  LinkPeer,
  type LoopbackGroup,
  PeerAuth,
  SharingGate,
} from "@shigomori/contracts/link";
import type { KeyPair } from "@shared/crypto/noise";
import {
  CLOSE_TRY_AGAIN,
  ROSTER_UNAVAILABLE,
  SEAL_OVERHEAD_BYTES,
  sealListener,
} from "@shared/remote/sealedSocket";
import { sameKey } from "@shared/crypto/deviceKey";
import {
  HELLO_TIMEOUT_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  MAX_IN_FLIGHT_PER_PEER,
} from "@shared/remote/link";
import * as HostPushes from "@host/lib/hostPushes";
import * as Sharing from "@host/lib/sharing";
import type { HostServices } from "@host/process/services";
import { type HostChannels, makeHostChannels } from "./channels";

// The listener's auth: what opens a socket, and the host's command
// switch. Injected so this module stays free of the ticket store and the
// account layer alike.
export type WsServerTicketAuth = {
  // What opens a socket. A peer's is sealed: `admit` spends the ticket
  // it opened with, for the path the connection arrived on, and names
  // the device the ticket was minted for with the key the hub's roster
  // holds for it, or null; `localKey` is this device's own pair. The
  // loopback's is its token, which the hello carries.
  readonly opens:
    | {
        // What a ticket opens, spending nothing: the device it was
        // minted for and the key the hub's roster holds for it, or null,
        // or ROSTER_UNAVAILABLE while the roster cannot be read.
        readonly check: (
          ticket: string,
          arrivedAs: DirectCandidateKind,
        ) =>
          | { deviceId: string; publicKey: Uint8Array }
          | null
          | typeof ROSTER_UNAVAILABLE;
        // Spends the ticket on its socket's hello, answering the device
        // it was minted for, or null when it is no longer pending.
        readonly spend: (
          ticket: string,
          arrivedAs: DirectCandidateKind,
        ) => string | null;
        // Drops the pending tickets of every device not in the roster,
        // as the roster sweep (closePeersNotIn) runs.
        readonly keepDevices: (deviceIds: readonly string[]) => void;
        // The key the roster holds for a device now, which the hello
        // rechecks: a device removed since its handshake links nothing.
        // ROSTER_UNAVAILABLE while the roster cannot be read, which says
        // nothing against the device.
        readonly keyOf: (
          deviceId: string,
        ) => Uint8Array | undefined | typeof ROSTER_UNAVAILABLE;
        readonly localKey: () => KeyPair | null;
      }
    | { readonly token: string };
  // Whether this host runs gated calls from its peers at all: every
  // ticketed peer is a device of the same account, so this one switch
  // is the whole verdict. Read at every call and every channel write,
  // so flipping it takes effect without a reconnect.
  isCommandGranted(): boolean;
  // The switch's one exception: a gated call this host asked the peer
  // to make (a mirror it invited, host/mirror/invites.ts), admitted
  // whatever the switch says, scoped by the call's payload. A byte
  // channel such a call attaches survives the switch turning off.
  isInvited?(peerDeviceId: string, channel: string, input: unknown): boolean;
};

// The sharing switch as the device link reads it (SharingGate). The
// loopback has none: its callers are this machine's own.
type LinkSharing = Pick<Sharing.Sharing["Service"], "current" | "changes"> & {
  // The pushes a peer still hears while it is off, beside
  // sharing:changed: what a mirror this host invited follows.
  readonly seesPush: (peerDeviceId: string, payload: unknown) => boolean;
};

// The host's word on its switches, which a peer hears either way.
const SWITCHES = new Set([
  channelOf(callOf(sharingContract, "changed")),
  channelOf(callOf(accountContract, "commandAccessChanged")),
]);

export type WsServerStartOpts = {
  port: number;
  // main binds "::" (dual stack), because it advertises IPv6
  // candidates too. Tests bind loopback.
  bindAddress: string;
  // This device's id and app version, for the welcome.
  deviceId: string;
  appVersion: string;
  // The account the listener serves: an account switch restarts it,
  // dropping every link from the old account. Unset in tests.
  accountId?: string;
  // The configured web client's origin, which the upgrade admits so a
  // browser dialing through the tunnel passes (isAllowedOrigin).
  allowedOrigin?: string;
  // Test seams. Real callers take the defaults.
  helloTimeoutMs?: number;
  livenessTimeoutMs?: number;
};

// So a bind failure (a taken port) is not a silent hole.
type LinkServerStatus = {
  listening: boolean;
  port: number | null;
  bindAddress: string | null;
  error: string | null;
};

// Total sockets (linked plus pending) the listener holds.
const MAX_CONNECTIONS = 64;
// Sockets before their hello, a tighter cap so a flood that never says
// hello cannot crowd out real peers.
const MAX_PREAUTH_CONNECTIONS = 16;
// The largest inbound frame: a channel write is at most 256 KiB of
// bytes and a few more of frame around them.
const MAX_INBOUND_FRAME_BYTES = 1 << 20;
// Lets a refusal's answer flush before the socket is cut.
const REJECT_TERMINATE_DELAY_MS = 250;
// How long a socket asked to close has before it is cut.
const TERMINATE_GRACE_MS = 1_500;
// Failed hellos from one client identity before a lockout window.
const AUTH_FAILURE_LIMIT = 5;
const AUTH_LOCKOUT_MS = 30_000;
// How often at most a refused web Origin is logged.
const ORIGIN_REJECT_LOG_THROTTLE_MS = 60_000;

// Close codes the listener refuses with, for the dialer's log line. The
// lockout is temporary and keyed on the client's address, so the
// dialer backs off through it rather than reading it as a refusal.
const CLOSE_GOING_AWAY = 1001;
const CLOSE_OVER_CAPACITY = 1013;
const CLOSE_HELLO_FAILED = 4002;
const CLOSE_AUTH_LOCKED_OUT = 4003;

function isLoopbackAddress(address: string): boolean {
  return (
    address.startsWith("127.") ||
    address === "::1" ||
    address.startsWith("::ffff:127.")
  );
}

// Whether the local cloudflared connector delivered this connection:
// it lands on loopback with the real client in CF-Connecting-IP. Only
// a loopback connection may name itself by the header, so a LAN peer
// cannot spoof its way into another lockout bucket.
function tunnelBorne(
  remoteAddress: string | undefined,
  cfConnectingIp: string | undefined,
): boolean {
  return (
    isLoopbackAddress(remoteAddress ?? "unknown") &&
    (cfConnectingIp?.trim() ?? "") !== ""
  );
}

// The identity the lockout and the log lines key on: the socket's
// address, or for a tunnel-borne connection the client's, since every
// one of those arrives from loopback.
function clientIdentityOf(
  remoteAddress: string | undefined,
  cfConnectingIp: string | undefined,
): string {
  return tunnelBorne(remoteAddress, cfConnectingIp)
    ? (cfConnectingIp ?? "").trim()
    : (remoteAddress ?? "unknown");
}

// The Origin pre-filter for the upgrade, not the security boundary (the
// hello's proof is). The desktop's dialer sends no Origin. The web
// client's browser always does, from a loopback http page or the one
// configured web origin.
function isAllowedOrigin(
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

// close() alone is advisory: ws keeps delivering frames for a while.
// The close frame, then a hard cut.
function closeThenTerminate(
  ws: WebSocket,
  code: number,
  reason: string,
  delayMs: number,
): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closing.
  }
  setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      // Already gone.
    }
  }, delayMs).unref();
}

type Push = { readonly channel: string; readonly payload: unknown };

type Served = (
  ctx: CallContext,
  input: unknown,
) => Effect.Effect<unknown, CallFailure, HostServices>;
type View = (input: unknown) => Stream.Stream<unknown, unknown, HostServices>;

// What the app registers to serve: every remote handler and view, by
// channel. The pushes it serves are the host's (HostPushes).
export type LinkRegistrar = Pick<
  EffectServerTransport<HostServices>,
  "handle"
> & {
  readonly served: ReadonlyMap<string, Served>;
  readonly views: ReadonlyMap<string, View>;
  readonly view: (channel: string, view: View) => void;
};

export function createLinkRegistrar(): LinkRegistrar {
  const served = new Map<string, Served>();
  const views = new Map<string, View>();
  const once = (channel: string) => {
    if (served.has(channel) || views.has(channel)) {
      throw new Error(`[link] "${channel}" is served already`);
    }
  };
  return {
    served,
    views,
    handle(channel, fn) {
      once(channel);
      served.set(channel, fn);
    },
    view(channel, view) {
      once(channel);
      views.set(channel, view);
    },
  };
}

// The graph's services, once the root has them: a call or a view that
// comes first waits for them, and is refused if the graph failed.
export type LateServices = Effect.Effect<
  Context.Context<HostServices>,
  CallFailure
>;

// A contract call: the registered handler, run with the graph's
// services, interrupted when the peer cancels it or its link drops, its
// failure crossing as the contract error it is, or as RemoteCallError
// with its message and code.
const serve =
  (channel: string, fn: Served, services: LateServices) => (payload: unknown) =>
    Effect.gen(function* () {
      const peer = yield* LinkPeer;
      const context = yield* services;
      return yield* fn(
        {
          connection: peer.closed,
          callerDeviceId: peer.deviceId,
          channels: peer.channels,
          notifier: (module, key) => (push) => peer.notify(module, key, push),
        },
        payload,
      ).pipe(Effect.provideContext(context));
    }).pipe(Effect.annotateSpans({ channel }));

// A frame's messages. One malformed frame is dropped rather than taking
// down a link carrying other calls.
function decodeFrame(
  parser: RpcSerialization.Parser,
  frame: Uint8Array | string,
): ReadonlyArray<RpcMessage.FromClientEncoded> {
  try {
    return parser.decode(frame) as ReadonlyArray<RpcMessage.FromClientEncoded>;
  } catch {
    log.warn("[link] dropping an unparseable frame");
    return [];
  }
}

// The answer for a call the link carries and nothing here serves.
const unserved = (tag: string) =>
  new RemoteCallError({ text: `No handler registered for channel "${tag}"` });

// One socket, from its accept to its close.
type Connection = {
  readonly ws: WebSocket;
  // What the link's frames go through: the socket itself on the
  // loopback, sealed on a peer's.
  readonly wire: Socket.WebSocketLike;
  readonly parser: RpcSerialization.Parser;
  readonly ip: string;
  readonly arrivalKind: DirectCandidateKind;
  readonly channels: HostChannels;
  // The pushes for this peer alone (a move's progress).
  readonly pushes: PubSub.PubSub<Push>;
  readonly closed: AbortController;
  // What this socket opened with, once its handshake proved the
  // dialer: the ticket, the device it was minted for, and the key the
  // dialer proved, the roster's then.
  opened: {
    readonly ticket: string;
    readonly deviceId: string;
    readonly publicKey: Uint8Array;
  } | null;
  helloSeen: boolean;
  deviceId: string | null;
  connectionId: string | null;
  inFlight: number;
  lastInboundAt: number;
  dead: boolean;
  kill(code: number, reason: string): void;
};

export class DeviceLink extends Context.Service<
  DeviceLink,
  {
    // Brings the listener to what `wanted` reads, serialized, so two
    // overlapping reconciles cannot apply a stale read last. Null stops
    // it, and the same options as the running listener change nothing.
    readonly reconcile: (
      wanted: Effect.Effect<WsServerStartOpts | null>,
    ) => Effect.Effect<void>;
    readonly status: Effect.Effect<LinkServerStatus>;
    // Cuts the links of the devices not in a roster the hub vouched for
    // as live: a revoked device, an account switch on its side.
    readonly closePeersNotIn: (
      online: readonly string[],
    ) => Effect.Effect<void>;
  }
>()("sm/host/DeviceLink") {}

// A link listener. The device link's serves LinkGroup to the peers
// the hub vouched for. `local` is the loopback's (loopback.ts): the
// processes on this machine the app's own credential admits, each its
// own caller with no device of its own, hearing every host push.
export const make = (options: {
  readonly registrar: LinkRegistrar;
  readonly auth: WsServerTicketAuth;
  readonly group?: typeof LinkGroup | typeof LoopbackGroup;
  readonly local?: boolean;
  readonly sharing?: LinkSharing;
  readonly services: LateServices;
}) =>
  Effect.gen(function* () {
    const { registrar, auth, sharing, services } = options;
    const group = (options.group ?? LinkGroup) as typeof LinkGroup;
    const local = options.local === true;
    const sharingNow =
      sharing === undefined ? Effect.succeed(true) : sharing.current;
    // The pushes every peer hears.
    const hostPushes = yield* HostPushes.HostPushes;
    const runFork = yield* FiberSet.makeRuntime<never>();
    const lifecycle = yield* Semaphore.make(1);
    const failedAuth = new Map<string, { count: number; until: number }>();
    let status: LinkServerStatus = {
      listening: false,
      port: null,
      bindAddress: null,
      error: null,
    };
    let current: {
      readonly opts: WsServerStartOpts;
      readonly scope: Scope.Closeable;
      readonly byDevice: Map<string, Map<string, Connection>>;
      // Every connection, those yet to say hello included.
      readonly connections: Map<number, Connection>;
    } | null = null;

    const isLockedOut = (ip: string): boolean => {
      const entry = failedAuth.get(ip);
      if (entry === undefined) return false;
      if (entry.until <= Date.now()) {
        failedAuth.delete(ip);
        return false;
      }
      return entry.count >= AUTH_FAILURE_LIMIT;
    };

    const recordAuthFailure = (ip: string): void => {
      const now = Date.now();
      for (const [key, entry] of failedAuth) {
        if (entry.until <= now) failedAuth.delete(key);
      }
      const entry = failedAuth.get(ip) ?? { count: 0, until: 0 };
      entry.count += 1;
      entry.until = now + AUTH_LOCKOUT_MS;
      failedAuth.set(ip, entry);
    };

    // One listener's life: the socket server, the RPC server over it,
    // and every connection, all in `scope`.
    const listen = (opts: WsServerStartOpts, scope: Scope.Scope) =>
      Effect.gen(function* () {
        // Each device's connections, by the id its dialer minted.
        const byDevice = new Map<string, Map<string, Connection>>();
        const connections = new Map<number, Connection>();
        let nextClientId = 0;
        let preAuth = 0;
        let originRejectLoggedAt = 0;
        // Effect's binary layout (shared/remote/link.ts), so a channel's
        // bytes cross as bytes.
        const serialization = yield* RpcSerialization.RpcSerialization.pipe(
          Effect.provide(RpcSerialization.layerSchemaBinary()),
        );
        const disconnects = yield* Queue.unbounded<number>();
        let writeRequest!: (
          clientId: number,
          message: RpcMessage.FromClientEncoded,
        ) => Effect.Effect<void>;

        const protocol = yield* RpcServer.Protocol.make((write) => {
          writeRequest = write;
          return Effect.succeed({
            disconnects,
            send: (clientId, response) =>
              Effect.sync(() => {
                const connection = connections.get(clientId);
                if (connection === undefined || connection.dead) return;
                const encoded = connection.parser.encode(response);
                if (
                  encoded !== undefined &&
                  connection.wire.readyState === WebSocket.OPEN
                ) {
                  connection.wire.send(encoded as Uint8Array<ArrayBuffer>);
                }
              }),
            end: () => Effect.void,
            clientIds: Effect.sync(() => new Set(connections.keys())),
            initialMessage: Effect.succeedNone,
            supportsAck: true,
            supportsTransferables: false,
            supportsSpanPropagation: true,
            supportsNotifications: true,
            codecFor: serialization.codecFor,
          } satisfies Omit<RpcServer.Protocol["Service"], "run">);
        });

        // The connection a call came on, which is there for as long as
        // its calls run: they are interrupted as it closes.
        const connectionOf = (clientId: number) =>
          Effect.suspend(() => {
            const connection = connections.get(clientId);
            return connection === undefined
              ? Effect.fail(new LinkUnauthenticatedError())
              : Effect.succeed(connection);
          });

        // A refusal answered, then the socket cut once it flushed.
        const killSoon = (
          connection: Connection,
          reason: string,
          code = CLOSE_HELLO_FAILED,
        ) =>
          Effect.sync(() =>
            setTimeout(
              () => connection.kill(code, reason),
              REJECT_TERMINATE_DELAY_MS,
            ).unref(),
          );

        const hello = (
          payload: {
            readonly deviceId: string;
            readonly deviceKind: DeviceKind;
            readonly connectionId: string;
            readonly appVersion: string;
            readonly protocolVersion: number;
            readonly token?: string;
          },
          clientId: number,
        ) =>
          Effect.gen(function* () {
            const connection = yield* connectionOf(clientId);
            if (payload.protocolVersion !== PROTOCOL_VERSION) {
              yield* killSoon(connection, "protocol version mismatch");
              return yield* new ProtocolVersionMismatchError({
                hostVersion: PROTOCOL_VERSION,
                clientVersion: payload.protocolVersion,
              });
            }
            if (connection.helloSeen) {
              yield* killSoon(connection, "hello out of turn");
              return yield* new LinkRefusedError();
            }
            connection.helloSeen = true;
            // A peer's hello names the device its ticket was minted for,
            // whose key the handshake proved and the roster still holds
            // for it, and only then spends the ticket: a device removed
            // since, or a socket that lost its ticket to another, links
            // nothing. The loopback's carries the token.
            const opens = auth.opens;
            const opened = connection.opened;
            const rosterKey =
              "token" in opens || opened === null
                ? undefined
                : opens.keyOf(opened.deviceId);
            // The hub out of reach is no verdict on this device: the
            // socket closes to be dialed again, its ticket kept and
            // nothing counted against its address.
            if (rosterKey === ROSTER_UNAVAILABLE) {
              log.warn(
                `[link] could not check a hello from ${connection.ip}: the account's roster is unavailable`,
              );
              yield* killSoon(
                connection,
                "the account's roster is unavailable",
                CLOSE_TRY_AGAIN,
              );
              return yield* new RemoteCallError({
                text: "The account's device list is unavailable. Try again.",
              });
            }
            const admitted =
              "token" in opens
                ? payload.token === opens.token
                : opened !== null &&
                  payload.deviceId === opened.deviceId &&
                  sameKey(rosterKey, opened.publicKey) &&
                  opens.spend(opened.ticket, connection.arrivalKind) ===
                    opened.deviceId;
            if (!admitted) {
              recordAuthFailure(connection.ip);
              log.warn(`[link] refused a hello from ${connection.ip}`);
              yield* killSoon(connection, "auth failed");
              return yield* new LinkRefusedError();
            }
            failedAuth.delete(connection.ip);
            preAuth -= 1;
            // The links this one replaces end now, so nothing they still
            // deliver runs: a desktop device's every other, a web
            // device's own stale one. On the loopback every caller is
            // its own, and none is a device the hub vouched for.
            if (!local) {
              const held =
                byDevice.get(payload.deviceId) ?? new Map<string, Connection>();
              for (const [connectionId, other] of held) {
                if (
                  payload.deviceKind === "desktop" ||
                  connectionId === payload.connectionId
                ) {
                  other.kill(CLOSE_GOING_AWAY, "superseded");
                }
              }
              held.set(payload.connectionId, connection);
              byDevice.set(payload.deviceId, held);
            }
            connection.deviceId = payload.deviceId;
            connection.connectionId = payload.connectionId;
            return { deviceId: opts.deviceId, appVersion: opts.appVersion };
          });

        // The bytes the switches gave: gone the moment either is off,
        // the ones an invited call opened aside.
        const underSwitch = (connection: Connection) =>
          Effect.gen(function* () {
            const shared = yield* sharingNow;
            if (!shared || !auth.isCommandGranted()) {
              connection.channels.dropUninvited();
            }
          });

        type Options = { readonly client: { readonly id: number } };
        const linkHandlers: Record<
          string,
          (payload: never, options: Options) => unknown
        > = {
          "link:hello": (
            payload: Parameters<typeof hello>[0],
            { client }: Options,
          ) => hello(payload, client.id),
          "link:ping": () => Effect.void,
          "link:read": (
            { channelId }: { channelId: string },
            { client }: Options,
          ) =>
            Stream.unwrap(
              Effect.tap(connectionOf(client.id), underSwitch).pipe(
                Effect.map((connection) => connection.channels.read(channelId)),
              ),
            ),
          "link:write": (
            {
              channelId,
              seq,
              data,
            }: { channelId: string; seq: number; data: Uint8Array },
            { client }: Options,
          ) =>
            Effect.tap(connectionOf(client.id), underSwitch).pipe(
              Effect.flatMap((connection) =>
                connection.channels.write(channelId, seq, data),
              ),
            ),
          "link:end": (
            { channelId }: { channelId: string },
            { client }: Options,
          ) =>
            Effect.flatMap(connectionOf(client.id), (connection) =>
              connection.channels.end(channelId),
            ),
          "link:reset": (
            { channelId }: { channelId: string },
            { client }: Options,
          ) =>
            Effect.flatMap(connectionOf(client.id), (connection) =>
              connection.channels.reset(channelId),
            ),
        };

        // What of the host's pushes on `channel` this peer hears while
        // sharing is off: the switches, and what a mirror the host
        // invited follows.
        const heard = (connection: Connection, channel: string) =>
          sharing === undefined || SWITCHES.has(channel)
            ? (pushes: Stream.Stream<unknown>) => pushes
            : Stream.filterEffect((payload: unknown) =>
                Effect.map(
                  sharing.current,
                  (on) =>
                    on ||
                    (connection.deviceId !== null &&
                      sharing.seesPush(connection.deviceId, payload)),
                ),
              );

        // A push: the host's own when it is one every peer may hear
        // (annotated `remote`), and the ones for this peer alone.
        const push =
          (channel: string, toEveryPeer: boolean) =>
          (_: undefined, { client }: Options) =>
            Stream.unwrap(
              Effect.map(connectionOf(client.id), (connection) =>
                Stream.merge(
                  toEveryPeer
                    ? hostPushes
                        .stream(channel)
                        .pipe(heard(connection, channel))
                    : Stream.empty,
                  Stream.fromPubSub(connection.pushes).pipe(
                    Stream.filter((entry) => entry.channel === channel),
                    Stream.map((entry) => entry.payload),
                  ),
                ),
              ),
            );

        // A view, failing as an invoke does: the contract error it is,
        // or RemoteCallError with its message and code.
        const watch = (view: View) => (payload: unknown) =>
          Stream.unwrap(
            Effect.map(services, (context) =>
              view(payload).pipe(Stream.provideContext(context)),
            ),
          ).pipe(Stream.mapError(callFailureOf));

        const handlers: Record<string, unknown> = { ...linkHandlers };
        for (const call of group.requests.values()) {
          const tag = channelOf(call);
          if (tag in handlers) continue;
          if (isBroadcast(call)) {
            handlers[tag] = push(
              tag,
              local || annotation(call, Remote) === true,
            );
            continue;
          }
          if (!isInvoke(call)) {
            const view = registrar.views.get(tag);
            handlers[tag] =
              view === undefined
                ? () => Stream.fail(unserved(tag))
                : watch(view);
            continue;
          }
          const fn = registrar.served.get(tag);
          handlers[tag] =
            fn === undefined
              ? () => Effect.fail(unserved(tag))
              : serve(tag, fn, services);
        }

        const peerAuth = Layer.succeed(PeerAuth, (effect, { client, rpc }) =>
          Effect.suspend(() => {
            const connection = connections.get(client.id);
            if (connection === undefined || connection.deviceId === null) {
              return Effect.fail(new LinkUnauthenticatedError());
            }
            const deviceId = connection.deviceId;
            // A stream (a push, a view, a channel's bytes) lives as
            // long as its reader wants it, so it holds no place.
            const streaming = !isInvoke(rpc as ContractCall);
            if (!streaming && connection.inFlight >= MAX_IN_FLIGHT_PER_PEER) {
              return Effect.fail(
                new RemoteCallError({ text: "too many in-flight requests" }),
              );
            }
            if (!streaming) connection.inFlight += 1;
            return effect.pipe(
              Effect.provideService(LinkPeer, {
                deviceId: local ? undefined : deviceId,
                closed: connection.closed.signal,
                channels: connection.channels,
                notify: (module, key, payload) => {
                  const { channel, parsed } = resolveBroadcast(
                    module,
                    key,
                    payload,
                  );
                  PubSub.publishUnsafe(connection.pushes, {
                    channel,
                    payload: parsed,
                  });
                },
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  if (!streaming) connection.inFlight -= 1;
                }),
              ),
            );
          }),
        );

        const commandGate = Layer.succeed(
          CommandGate,
          (effect, { rpc, payload }) =>
            Effect.gen(function* () {
              const peer = yield* LinkPeer;
              // Only an explicit gated:false is a read. A missing
              // annotation is gated like a command.
              if (annotation(rpc as ContractCall, Gated) === false) {
                return yield* effect;
              }
              if (
                peer.deviceId !== undefined &&
                auth.isInvited?.(peer.deviceId, channelOf(rpc), payload) ===
                  true
              ) {
                return yield* effect.pipe(
                  Effect.provideService(LinkPeer, {
                    ...peer,
                    channels: {
                      ...peer.channels,
                      attach: (channelId, endpoint) =>
                        peer.channels.attach(channelId, endpoint, {
                          invited: true,
                        }),
                    },
                  }),
                );
              }
              if (!auth.isCommandGranted()) {
                return yield* new CommandRefusedError();
              }
              return yield* effect;
            }),
        );

        const sharingGate = Layer.succeed(
          SharingGate,
          (effect, { rpc, payload }) =>
            Effect.gen(function* () {
              const peer = yield* LinkPeer;
              const tag = channelOf(rpc);
              if (
                tag.startsWith("link:") ||
                isBroadcast(rpc as ContractCall) ||
                (peer.deviceId !== undefined &&
                  auth.isInvited?.(peer.deviceId, tag, payload) === true)
              ) {
                return yield* effect;
              }
              if (sharing === undefined || !(yield* sharing.current)) {
                return yield* new NotSharingError();
              }
              // A call or a view under way ends as the switch turns off.
              const off = sharing.changes.pipe(
                Stream.filter((on) => !on),
                Stream.runHead,
                Effect.andThen(Effect.fail(new NotSharingError())),
              );
              return yield* Effect.raceFirst(effect, off);
            }),
        );

        yield* RpcServer.make(group, {
          spanPrefix: "DeviceLink",
          // A handler's defect fails its own call, not every call on
          // the link.
          disableFatalDefects: true,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayer(Effect.succeed(handlers as never)),
              peerAuth,
              sharingGate,
              commandGate,
              Layer.succeed(RpcServer.Protocol, protocol),
            ),
          ),
          Effect.forkIn(scope),
        );

        // A connection's frames into the RPC server, until it closes.
        const serveSocket = (clientId: number, connection: Connection) =>
          Effect.gen(function* () {
            const socket = yield* Socket.fromWebSocket(
              Effect.succeed(connection.wire),
            );
            const { pull } = yield* socket.reader;
            while (true) {
              const frames = yield* pull;
              connection.lastInboundAt = Date.now();
              for (const frame of frames) {
                if (connection.dead) return;
                const messages = decodeFrame(connection.parser, frame);
                for (const message of messages) {
                  yield* writeRequest(clientId, message);
                }
              }
            }
          }).pipe(
            Effect.scoped,
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                connection.kill(CLOSE_GOING_AWAY, "closed");
                connections.delete(clientId);
                Queue.offerUnsafe(disconnects, clientId);
              }),
            ),
          );

        const wss = new WebSocketServer({
          host: opts.bindAddress,
          port: opts.port,
          // A frame at the cap, sealed, carries its tag too.
          maxPayload: MAX_INBOUND_FRAME_BYTES + SEAL_OVERHEAD_BYTES,
          // No permessage-deflate: every frame is ciphertext, which does
          // not compress, so deflate would only add to each frame and
          // push one at the cap past it.
          perMessageDeflate: false,
          verifyClient: (info: { req: IncomingMessage }) => {
            const origin = info.req.headers.origin;
            const allowed = isAllowedOrigin(origin, opts.allowedOrigin);
            const at = Date.now();
            if (
              !allowed &&
              at - originRejectLoggedAt >= ORIGIN_REJECT_LOG_THROTTLE_MS
            ) {
              originRejectLoggedAt = at;
              log.warn(
                `[link] refusing an upgrade from origin ${origin}` +
                  " (a web client needs SM_ACCOUNT_WEB_ORIGIN set to its" +
                  " exact origin on this device)",
              );
            }
            return allowed;
          },
        });

        wss.on("connection", (ws, req) => {
          const forwardedFor = req.headers["cf-connecting-ip"];
          const cfConnectingIp = Array.isArray(forwardedFor)
            ? forwardedFor[0]
            : forwardedFor;
          const ip = clientIdentityOf(req.socket.remoteAddress, cfConnectingIp);
          if (connections.size >= MAX_CONNECTIONS) {
            closeThenTerminate(ws, CLOSE_OVER_CAPACITY, "over capacity", 50);
            return;
          }
          if (preAuth >= MAX_PREAUTH_CONNECTIONS) {
            closeThenTerminate(
              ws,
              CLOSE_OVER_CAPACITY,
              "too many pending connections",
              50,
            );
            return;
          }
          // Its own code: the client refused may hold a perfectly good
          // ticket and share an address with whoever spent the
          // attempts, so it backs off rather than giving up.
          if (isLockedOut(ip)) {
            log.warn(`[link] refusing a connection from locked-out ${ip}`);
            closeThenTerminate(
              ws,
              CLOSE_AUTH_LOCKED_OUT,
              "temporarily locked out",
              50,
            );
            return;
          }
          ws.on("error", (error) => {
            log.warn(`[link] connection error: ${errorMessageOf(error)}`);
          });
          preAuth += 1;
          const clientId = nextClientId++;
          const closed = new AbortController();
          const arrivalKind: DirectCandidateKind = tunnelBorne(
            req.socket.remoteAddress,
            cfConnectingIp,
          )
            ? "tunnel"
            : "lan";
          const opens = auth.opens;
          const localKey = "token" in opens ? null : opens.localKey();
          if (!("token" in opens) && localKey === null) {
            closeThenTerminate(ws, CLOSE_HELLO_FAILED, "signed out", 50);
            preAuth -= 1;
            return;
          }
          runFork(
            Effect.gen(function* () {
              const pushes = yield* PubSub.sliding<Push>(1024);
              const connection: Connection = {
                ws,
                wire:
                  "token" in opens || localKey === null
                    ? ws
                    : sealListener(ws, {
                        localKey,
                        admit: async (ticket) => {
                          const peer = opens.check(ticket, arrivalKind);
                          return peer === ROSTER_UNAVAILABLE
                            ? peer
                            : (peer?.publicKey ?? null);
                        },
                        opened: (ticket, publicKey) => {
                          const peer = opens.check(ticket, arrivalKind);
                          if (
                            peer !== null &&
                            peer !== ROSTER_UNAVAILABLE &&
                            sameKey(peer.publicKey, publicKey)
                          ) {
                            connection.opened = { ticket, ...peer };
                          }
                        },
                        // Only a ticket or a key that did not hold counts
                        // toward the lockout: a device on another version
                        // dialing in the middle of an upgrade is refused
                        // without benching its address.
                        refused: (reason, guessed) => {
                          if (guessed) recordAuthFailure(ip);
                          log.warn(
                            `[link] refused a socket from ${ip}: ${reason}`,
                          );
                        },
                      }),
                ip,
                arrivalKind,
                channels: makeHostChannels(),
                pushes,
                closed,
                parser: serialization.makeUnsafe(),
                opened: null,
                helloSeen: false,
                deviceId: null,
                connectionId: null,
                inFlight: 0,
                lastInboundAt: Date.now(),
                dead: false,
                kill(code, reason) {
                  if (connection.dead) return;
                  connection.dead = true;
                  if (connection.deviceId === null) preAuth -= 1;
                  else {
                    const held = byDevice.get(connection.deviceId);
                    const id = connection.connectionId;
                    if (id !== null && held?.get(id) === connection) {
                      held.delete(id);
                      if (held.size === 0) byDevice.delete(connection.deviceId);
                    }
                  }
                  connection.channels.closeAll();
                  connection.closed.abort();
                  closeThenTerminate(
                    ws,
                    code,
                    reason,
                    REJECT_TERMINATE_DELAY_MS,
                  );
                },
              };
              connections.set(clientId, connection);
              // A hello arriving after this does not count.
              setTimeout(() => {
                if (connection.deviceId === null) {
                  connection.kill(CLOSE_HELLO_FAILED, "hello timeout");
                }
              }, opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS).unref();
              yield* serveSocket(clientId, connection);
            }),
          );
        });

        yield* Effect.callback<void, Error>((resume) => {
          wss.once("error", (error) => resume(Effect.fail(error)));
          wss.once("listening", () => resume(Effect.void));
        });
        wss.on("error", (error) => {
          status = { ...status, error: errorMessageOf(error) };
          log.warn(`[link] listener error: ${errorMessageOf(error)}`);
        });

        // A peer silent past the timeout is cut, as if the roster had
        // dropped it.
        const livenessMs = opts.livenessTimeoutMs ?? HOST_LIVENESS_TIMEOUT_MS;
        yield* Effect.sync(() => {
          const now = Date.now();
          for (const connection of connections.values()) {
            if (now - connection.lastInboundAt > livenessMs) {
              connection.kill(CLOSE_GOING_AWAY, "heartbeat timeout");
            }
          }
        }).pipe(
          Effect.repeat(
            Schedule.spaced(Math.max(50, Math.floor(livenessMs / 4))),
          ),
          Effect.forkIn(scope),
        );

        yield* Scope.addFinalizer(
          scope,
          Effect.callback<void>((resume) => {
            for (const connection of connections.values()) {
              connection.kill(CLOSE_GOING_AWAY, "server stopping");
            }
            const grace = setTimeout(() => {
              for (const ws of wss.clients) ws.terminate();
            }, TERMINATE_GRACE_MS);
            wss.close(() => {
              clearTimeout(grace);
              resume(Effect.void);
            });
          }),
        );

        const address = wss.address();
        const port =
          typeof address === "object" && address !== null
            ? address.port
            : opts.port;
        log.info(`[link] listening on ${opts.bindAddress}:${port}`);
        return { port, byDevice, connections };
      });

    const stopNow = Effect.suspend(() => {
      const running = current;
      if (running === null) return Effect.void;
      current = null;
      status = { listening: false, port: null, bindAddress: null, error: null };
      return Scope.close(running.scope, Exit.void);
    });

    const sameListener = (opts: WsServerStartOpts): boolean => {
      if (current === null) return false;
      const was = current.opts;
      return (
        was.port === opts.port &&
        was.bindAddress === opts.bindAddress &&
        was.accountId === opts.accountId &&
        was.allowedOrigin === opts.allowedOrigin
      );
    };

    const startNow = (opts: WsServerStartOpts) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const started = yield* Effect.exit(listen(opts, scope));
        if (Exit.isFailure(started)) {
          yield* Scope.close(scope, Exit.void);
          const error = errorMessageOf(
            Option.getOrElse(Exit.findErrorOption(started), () => "failed"),
          );
          status = {
            listening: false,
            port: null,
            bindAddress: opts.bindAddress,
            error,
          };
          log.error(
            `[link] bind failed on ${opts.bindAddress}:${opts.port}: ${error}`,
          );
          return;
        }
        current = {
          opts,
          scope,
          byDevice: started.value.byDevice,
          connections: started.value.connections,
        };
        status = {
          listening: true,
          port: started.value.port,
          bindAddress: opts.bindAddress,
          error: null,
        };
      });

    yield* Effect.addFinalizer(() => lifecycle.withPermits(1)(stopNow));

    return DeviceLink.of({
      reconcile: (wanted) =>
        lifecycle.withPermits(1)(
          Effect.gen(function* () {
            const opts = yield* wanted;
            if (opts !== null && sameListener(opts)) return;
            yield* stopNow;
            if (opts !== null) yield* startNow(opts);
          }),
        ),
      status: Effect.sync(() => ({ ...status })),
      closePeersNotIn: (online) =>
        Effect.sync(() => {
          const live = new Set(online);
          // A device the roster dropped spends nothing it was handed.
          if (!("token" in auth.opens)) auth.opens.keepDevices(online);
          // Linked or still to say hello: a socket whose handshake proved
          // a device the roster dropped goes too.
          for (const connection of current?.connections.values() ?? []) {
            const deviceId = connection.deviceId ?? connection.opened?.deviceId;
            if (deviceId === undefined || live.has(deviceId)) continue;
            connection.kill(
              CLOSE_GOING_AWAY,
              "no longer in the account roster",
            );
          }
        }),
    });
  });

export const layer = (options: {
  readonly registrar: LinkRegistrar;
  readonly auth: WsServerTicketAuth;
  readonly seesPush: LinkSharing["seesPush"];
  readonly services: LateServices;
}) =>
  Layer.effect(
    DeviceLink,
    Effect.gen(function* () {
      const sharing = yield* Sharing.Sharing;
      return yield* make({
        registrar: options.registrar,
        auth: options.auth,
        services: options.services,
        sharing: {
          current: sharing.current,
          changes: sharing.changes,
          seesPush: options.seesPush,
        },
      });
    }),
  );
