// The host side of the device link (shared/remote/link.ts): the
// listener another device dials, serving every contract call annotated
// `remote` over Effect RPC, the pushes as streams, and the byte
// channels. Registration and listening are apart on purpose:
// main/ipc/register.ts records every remote handler in the registrar at
// boot whether or not the device is enrolled, so signing in later only
// starts the listener.
//
// A connection opens with the handshake (modules/link.ts): the ticket a
// peer proves was minted for it over the hub, bound to its deviceId, and
// its protocol version must be this build's. Until then every other
// call is refused (PeerAuth). Then a call annotated gated:false runs for
// the peer, and any other only under the host's live command switch, or
// as a call the host itself invited (CommandGate). One link per device:
// a second hello from the same device supersedes the first.
//
// The listener sits on every interface (and behind the tunnel), so it
// is written to be hostile-safe: an inbound frame cap, an Origin gate,
// connection and in-flight caps, a failed-auth lockout, and hard
// termination on every rejection and shutdown.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  annotation,
  channelOf,
  type ContractCall,
  Gated,
  isBroadcast,
} from "@shigomori/contracts/contract";
import {
  CommandRefusedError,
  errorCodeOf,
  errorMessageOf,
  isContractError,
  LinkRefusedError,
  LinkUnauthenticatedError,
  ProtocolVersionMismatchError,
  RemoteCallError,
} from "@shigomori/contracts/errors";
import type { DirectCandidateKind } from "@shigomori/contracts/modules/direct";
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
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import { log } from "@shared/log";
import {
  CommandGate,
  HELLO_TIMEOUT_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  LinkGroup,
  LinkPeer,
  MAX_IN_FLIGHT_PER_PEER,
  PeerAuth,
} from "@shared/remote/link";
import {
  handshakeProof,
  newHandshakeNonce,
  proofsMatch,
} from "@shared/remote/proof";
import * as PromiseAdapter from "@host/lib/util/promiseAdapter";
import { type HostChannels, makeHostChannels } from "./channels";

// The listener's auth: the single-use connect tickets minted over the
// hub, and the host's command switch. Injected so this module stays
// free of the ticket store and the account layer alike.
export type WsServerTicketAuth = {
  // Consumes the ticket the peer proved it holds (it never travels,
  // shared/remote/proof.ts), for the claimed deviceId and the path the
  // connection arrived on, and hands it back so the host can prove it
  // too. Null when nothing matches.
  matchTicket(
    deviceId: string,
    arrivedAs: DirectCandidateKind,
    matches: (ticket: string) => Promise<boolean>,
  ): Promise<string | null>;
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
// The largest inbound frame: a channel write is at most 256 KiB, which
// is about 342 KiB as base64 in its JSON.
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
// hello's proof is). The desktop's dialer sends no Origin; the web
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

type Served = (ctx: HandlerContext, input: unknown) => Promise<unknown>;

// What the app registers to serve: every remote handler, and the
// pushes it fans out to every linked peer.
export type LinkRegistrar = ServerTransport & {
  readonly served: ReadonlyMap<string, Served>;
  readonly pushes: PubSub.PubSub<Push>;
};

export function createLinkRegistrar(): LinkRegistrar {
  const served = new Map<string, Served>();
  const pushes = Effect.runSync(PubSub.unbounded<Push>());
  return {
    served,
    pushes,
    handle(channel, fn) {
      if (served.has(channel)) {
        throw new Error(`[link] handler already registered for "${channel}"`);
      }
      served.set(channel, fn);
    },
    broadcastAll(channel, payload) {
      PubSub.publishUnsafe(pushes, { channel, payload });
    },
  };
}

// A contract call: the registered handler, its signal aborted when the
// call is interrupted (the peer cancelling it, or its link dropping),
// its failure crossing as the contract error it is, or as
// RemoteCallError with its message and code.
const serve = (channel: string, fn: Served) => (payload: unknown) =>
  Effect.gen(function* () {
    const peer = yield* LinkPeer;
    return yield* Effect.tryPromise({
      try: (signal) =>
        fn(
          {
            signal,
            connection: peer.closed,
            callerDeviceId: peer.deviceId,
            channels: peer.channels,
            notifier: (module, key) => (push) => peer.notify(module, key, push),
          },
          payload,
        ),
      catch: (error) =>
        isContractError(error)
          ? error
          : new RemoteCallError({
              text: errorMessageOf(error),
              code: errorCodeOf(error),
            }),
    });
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

// One socket, from its accept to its close.
type Connection = {
  readonly ws: WebSocket;
  readonly parser: RpcSerialization.Parser;
  readonly ip: string;
  readonly arrivalKind: DirectCandidateKind;
  readonly channels: HostChannels;
  // The pushes for this peer alone (a move's progress).
  readonly pushes: PubSub.PubSub<Push>;
  readonly closed: AbortController;
  hostNonce: string | null;
  helloSeen: boolean;
  deviceId: string | null;
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
    // it; the same options as the running listener change nothing.
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

const make = (options: {
  readonly registrar: LinkRegistrar;
  readonly auth: WsServerTicketAuth;
}) =>
  Effect.gen(function* () {
    const { registrar, auth } = options;
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
      readonly byDevice: Map<string, Connection>;
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
        const byDevice = new Map<string, Connection>();
        const connections = new Map<number, Connection>();
        let nextClientId = 0;
        let preAuth = 0;
        let originRejectLoggedAt = 0;
        const serialization = RpcSerialization.json;
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
                  connection.ws.readyState === WebSocket.OPEN
                ) {
                  connection.ws.send(encoded);
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
        const killSoon = (connection: Connection, reason: string) =>
          Effect.sync(() =>
            setTimeout(
              () => connection.kill(CLOSE_HELLO_FAILED, reason),
              REJECT_TERMINATE_DELAY_MS,
            ).unref(),
          );

        const hello = (
          payload: {
            readonly deviceId: string;
            readonly appVersion: string;
            readonly protocolVersion: number;
            readonly nonce: string;
            readonly proof: string;
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
            const hostNonce = connection.hostNonce;
            if (connection.helloSeen || hostNonce === null) {
              yield* killSoon(connection, "hello out of turn");
              return yield* new LinkRefusedError();
            }
            connection.helloSeen = true;
            const ticket = yield* Effect.promise(() =>
              auth.matchTicket(
                payload.deviceId,
                connection.arrivalKind,
                async (candidate) =>
                  proofsMatch(
                    payload.proof,
                    await handshakeProof(
                      candidate,
                      "client",
                      hostNonce,
                      payload.nonce,
                    ),
                  ),
              ),
            );
            if (connection.dead) return yield* new LinkRefusedError();
            if (ticket === null) {
              recordAuthFailure(connection.ip);
              // The owner gets a real signal under a brute force attempt.
              log.warn(
                `[link] refused a hello with a bad proof from ${connection.ip}`,
              );
              yield* killSoon(connection, "auth failed");
              return yield* new LinkRefusedError();
            }
            failedAuth.delete(connection.ip);
            preAuth -= 1;
            // One link per device: the older one ends now, so nothing it
            // still delivers runs.
            byDevice
              .get(payload.deviceId)
              ?.kill(CLOSE_GOING_AWAY, "superseded");
            byDevice.set(payload.deviceId, connection);
            connection.deviceId = payload.deviceId;
            return {
              deviceId: opts.deviceId,
              appVersion: opts.appVersion,
              proof: yield* Effect.promise(() =>
                handshakeProof(ticket, "host", hostNonce, payload.nonce),
              ),
            };
          });

        // The bytes the command switch gave: gone the moment it is off,
        // the ones an invited call opened aside.
        const underSwitch = (connection: Connection) =>
          Effect.sync(() => {
            if (!auth.isCommandGranted()) connection.channels.dropUninvited();
          });

        type Options = { readonly client: { readonly id: number } };
        const linkHandlers: Record<
          string,
          (payload: never, options: Options) => unknown
        > = {
          "link:challenge": (_: undefined, { client }: Options) =>
            Effect.map(connectionOf(client.id), (connection) => {
              connection.hostNonce ??= newHandshakeNonce();
              return { nonce: connection.hostNonce };
            }),
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

        // A push: every one fanned out to all peers, and the ones for
        // this peer alone.
        const push =
          (channel: string) =>
          (_: undefined, { client }: Options) =>
            Stream.unwrap(
              Effect.map(connectionOf(client.id), (connection) =>
                Stream.merge(
                  Stream.fromPubSub(registrar.pushes),
                  Stream.fromPubSub(connection.pushes),
                ).pipe(
                  Stream.filter((entry) => entry.channel === channel),
                  Stream.map((entry) => entry.payload),
                ),
              ),
            );

        const handlers: Record<string, unknown> = { ...linkHandlers };
        for (const call of LinkGroup.requests.values()) {
          const tag = channelOf(call);
          if (tag in handlers) continue;
          if (isBroadcast(call as ContractCall)) {
            handlers[tag] = push(tag);
            continue;
          }
          const fn = registrar.served.get(tag);
          handlers[tag] =
            fn === undefined
              ? () =>
                  Effect.fail(
                    new RemoteCallError({
                      text: `No handler registered for channel "${tag}"`,
                    }),
                  )
              : serve(tag, fn);
        }

        const peerAuth = Layer.succeed(PeerAuth, (effect, { client, rpc }) =>
          Effect.suspend(() => {
            const connection = connections.get(client.id);
            if (connection === undefined || connection.deviceId === null) {
              return Effect.fail(new LinkUnauthenticatedError());
            }
            const deviceId = connection.deviceId;
            const streaming = isBroadcast(rpc as ContractCall);
            if (!streaming && connection.inFlight >= MAX_IN_FLIGHT_PER_PEER) {
              return Effect.fail(
                new RemoteCallError({ text: "too many in-flight requests" }),
              );
            }
            if (!streaming) connection.inFlight += 1;
            return effect.pipe(
              Effect.provideService(LinkPeer, {
                deviceId,
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
              // Only an explicit gated:false is a read; a missing
              // annotation is gated like a command.
              if (annotation(rpc as ContractCall, Gated) === false) {
                return yield* effect;
              }
              if (
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

        yield* RpcServer.make(LinkGroup, {
          spanPrefix: "DeviceLink",
          // A handler's defect fails its own call, not every call on
          // the link.
          disableFatalDefects: true,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              LinkGroup.toLayer(Effect.succeed(handlers as never)),
              peerAuth,
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
              Effect.succeed(connection.ws),
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
          maxPayload: MAX_INBOUND_FRAME_BYTES,
          // A browser offers it, and so does the desktop dialer on a
          // tunnel candidate, where a diff or a log is worth the CPU. A
          // LAN dial does not ask: its link outruns the deflate.
          perMessageDeflate: { threshold: 1024 },
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
          runFork(
            Effect.gen(function* () {
              const pushes = yield* PubSub.sliding<Push>(1024);
              const connection: Connection = {
                ws,
                ip,
                arrivalKind: tunnelBorne(
                  req.socket.remoteAddress,
                  cfConnectingIp,
                )
                  ? "tunnel"
                  : "lan",
                channels: makeHostChannels(),
                pushes,
                closed,
                parser: serialization.makeUnsafe(),
                hostNonce: null,
                helloSeen: false,
                deviceId: null,
                inFlight: 0,
                lastInboundAt: Date.now(),
                dead: false,
                kill(code, reason) {
                  if (connection.dead) return;
                  connection.dead = true;
                  if (connection.deviceId === null) preAuth -= 1;
                  else if (byDevice.get(connection.deviceId) === connection) {
                    byDevice.delete(connection.deviceId);
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
        return { port, byDevice };
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
        current = { opts, scope, byDevice: started.value.byDevice };
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
          for (const [deviceId, connection] of current?.byDevice ?? []) {
            if (!live.has(deviceId)) {
              connection.kill(
                CLOSE_GOING_AWAY,
                "no longer in the account roster",
              );
            }
          }
        }),
    });
  });

export const layer = (options: {
  readonly registrar: LinkRegistrar;
  readonly auth: WsServerTicketAuth;
}) => Layer.effect(DeviceLink, make(options));

const promiseAdapter = PromiseAdapter.forService(DeviceLink, "The device link");
export const adapter = promiseAdapter.layer;

// The listener's Promise face, for main/ipc/register.ts.
export const deviceLink = {
  // `resolve` reads the wanted state inside the serialized reconcile.
  refresh: (resolve: () => Promise<WsServerStartOpts | null>) =>
    promiseAdapter.call((link) => link.reconcile(Effect.promise(resolve))),
  status: (): LinkServerStatus =>
    promiseAdapter.runSyncOr(
      Effect.flatMap(DeviceLink, (link) => link.status),
      () => ({ listening: false, port: null, bindAddress: null, error: null }),
    ),
  closePeersNotIn: (online: readonly string[]) =>
    promiseAdapter.runIfOpen(
      Effect.flatMap(DeviceLink, (link) => link.closePeersNotIn(online)),
    ),
};
