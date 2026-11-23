// The host side of a link (shared/remote/link.ts): every contract call
// the far end's group holds over Effect RPC, the pushes as streams, and
// the byte channels. The handlers (hostRpc.ts) are the layer's, there
// from boot whether or not the device is enrolled.
//
// A peer's link is Colibrii's (@colibrii/sdk), which proved the device
// at its other end before `admit` reads its greeting: the dialer's core
// must be this build's. A call annotated gated:false then runs for the
// peer, and any other only under the host's live command switch
// (CommandGate). Above both sits the sharing switch: off, every call is
// refused, reads included, and a push reaches a peer only where the
// host still lets it (SharingGate).
//
// The loopback's (Loopback.ts) is a WebSocket from a process on this
// machine, whose hello carries the host's token. Its callers command
// this machine as its owner.
import {
  decodeFrame,
  frameWords,
  makeServerProtocol,
} from "@shared/remote/rpcServer";
import * as Result from "effect/Result";
import type { DeviceKind } from "@shigomori/contracts/modules/link";
import {
  annotation,
  callOf,
  callsOf,
  channelOf,
  type ContractCall,
  Gated,
  isPush,
  isInvoke,
  Remote,
} from "@shigomori/contracts/contract";
import {
  CommandRefusedError,
  LinkRefusedError,
  LinkUnauthenticatedError,
  NotSharingError,
  ProtocolVersionMismatchError,
  RemoteCallError,
} from "@shigomori/contracts/errors";
import { accountContract } from "@shigomori/contracts/modules/account";
import { sessionContract } from "@shigomori/contracts/modules/session";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import { CORE_VERSION } from "@shigomori/contracts/protocol";
import { AppRefusal, type IncomingHello, type Link } from "@colibrii/sdk";
import { boundedMessages } from "./boundedMessages";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { resolvePush } from "@shared/ipc/push";
import { log } from "@shared/log";
import {
  decodeHello,
  encodeRefusal,
  encodeWelcome,
} from "@shared/remote/greeting";
import { HELLO_TIMEOUT_MS } from "@shared/remote/link";
import { linkSocket } from "@shared/remote/linkSocket";
import {
  CommandGate,
  LinkGroup,
  LinkPeer,
  type LoopbackGroup,
  PeerAuth,
  SharingGate,
  versionsOf,
} from "@shigomori/contracts/link";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as HostFacts from "@host/lib/HostFacts";
import * as HostPushes from "@host/lib/HostPushes";
import { secretsMatch } from "@host/lib/util/secretCompare";
import * as Sharing from "@host/lib/Sharing";
import { type HostChannels, makeHostChannels } from "./channels";

// The sharing switch as a peer's link reads it (SharingGate). The
// loopback has none: its callers are this machine's own.
type LinkSharing = Pick<
  Sharing.Sharing["Service"],
  "current" | "now" | "changes"
>;

// The calls the shell makes of its host (modules/session.ts), which no
// other caller on the loopback may.
const SHELL_SESSION = new Set(callsOf(sessionContract).map(channelOf));

const COMMAND_ACCESS_CHANGED = channelOf(
  callOf(accountContract, "commandAccessChanged"),
);

const SHARING_CHANGED = channelOf(callOf(sharingContract, "changed"));

// The host's word on its switches, which a peer hears either way.
const SWITCHES = new Set([SHARING_CHANGED, COMMAND_ACCESS_CHANGED]);

// Lets a refusal's answer flush before the socket is cut.
const REJECT_TERMINATE_DELAY_MS = 250;

// Close codes a connection is cut with, for the far end's log line.
const CLOSE_GOING_AWAY = 1001;
const CLOSE_HELLO_FAILED = 4002;
// The standard code for data a socket can't take.
const CLOSE_UNREADABLE = 1007;

type Push = { readonly channel: string; readonly payload: unknown };

// The answer for a call the link carries and nothing here serves.
const unserved = (tag: string) =>
  new RemoteCallError({ text: `No handler registered for channel "${tag}"` });

// Where a connection is in its life: a loopback socket yet to say hello,
// linked (a peer's from the start), dead once kill() ran. Only a socket
// yet to say hello is admitted, so a hello after its cut links nothing.
type Phase =
  | { readonly kind: "preAuth" }
  | {
      readonly kind: "linked";
      readonly deviceId: string;
      // The loopback's: whether the hello carried the shell's token.
      readonly shell: boolean;
    }
  | { readonly kind: "dead" };

// One connection, from its accept to its close.
type Connection = {
  readonly wire: Socket.WebSocketLike;
  readonly parser: RpcSerialization.Parser;
  // Where it came from, for the log.
  readonly from: string;
  readonly channels: HostChannels;
  // The pushes for this peer alone (a move's progress).
  readonly pushes: PubSub.PubSub<Push>;
  readonly closed: AbortController;
  phase: Phase;
  kill(code: number, reason: string): void;
};

type LinkServer = {
  // Serves `wire` until it closes: a peer's linked from the start, a
  // loopback socket once its hello is admitted. `cut` ends the wire.
  readonly accept: (
    wire: Socket.WebSocketLike,
    options: {
      readonly from: string;
      readonly peer?: string;
      readonly cut: (code: number, reason: string) => void;
    },
  ) => Effect.Effect<void>;
};

// A link server. A peer's serves LinkGroup to the devices Colibrii let
// in. `tokens` makes it the loopback's: the processes on this machine
// its token admits, each its own caller with no device of its own,
// hearing every host push.
export const makeServer = (options: {
  readonly group?: typeof LinkGroup | typeof LoopbackGroup;
  readonly tokens?: { readonly token: string; readonly shellToken: string };
  readonly deviceId: string;
  readonly appVersion: string;
  // Whether this host runs gated calls from its peers at all: every
  // peer is a device of the same account, so this one switch is the
  // whole verdict. Read at every call and every channel write, so
  // flipping it takes effect without a reconnect.
  readonly isCommandGranted: () => boolean;
  readonly sharing?: LinkSharing;
}) =>
  Effect.gen(function* () {
    const { sharing, tokens } = options;
    const group = (options.group ?? LinkGroup) as typeof LinkGroup;
    const versions = versionsOf(group);
    const local = tokens !== undefined;
    const sharingNow =
      sharing === undefined ? Effect.succeed(true) : sharing.current;
    // The pushes every peer hears.
    const hostPushes = yield* HostPushes.HostPushes;
    // The server's context, whose RPC handlers are the host's
    // (hostRpc.ts).
    const served = yield* Effect.context<Rpc.Handler<string>>();
    const connections = new Map<number, Connection>();
    let nextClientId = 0;
    const server = yield* makeServerProtocol({
      client: (clientId) => {
        const connection = connections.get(clientId);
        return connection === undefined || connection.phase.kind === "dead"
          ? undefined
          : {
              parser: connection.parser,
              send: (encoded) => {
                if (connection.wire.readyState === 1) {
                  connection.wire.send(encoded);
                }
              },
            };
      },
      clientIds: () => new Set(connections.keys()),
    });
    const { protocol } = server;

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

    // The loopback's hello: this build's core, and the token, or the
    // shell's, which alone opens the shell's session calls too. A
    // peer's link is linked from the start, and says none.
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
        if (connection.phase.kind !== "preAuth" || tokens === undefined) {
          return yield* new LinkRefusedError();
        }
        if (payload.protocolVersion !== CORE_VERSION) {
          yield* killSoon(connection, "protocol version mismatch");
          return yield* new ProtocolVersionMismatchError({
            hostVersion: CORE_VERSION,
            clientVersion: payload.protocolVersion,
          });
        }
        const token = payload.token ?? "";
        const shell = secretsMatch(token, tokens.shellToken);
        if (!shell && !secretsMatch(token, tokens.token)) {
          log.warn(`[link] refused a hello from ${connection.from}`);
          yield* killSoon(connection, "auth failed");
          return yield* new LinkRefusedError();
        }
        connection.phase = {
          kind: "linked",
          deviceId: payload.deviceId,
          shell,
        };
        return {
          deviceId: options.deviceId,
          appVersion: options.appVersion,
          versions,
        };
      });

    // The bytes the switches gave: gone the moment either is off.
    // Dropped as the switch turns (below), and again at a read or
    // write, for a channel a call attached as it turned.
    const underSwitch = (connection: Connection) =>
      Effect.gen(function* () {
        const shared = yield* sharingNow;
        if (!shared || !options.isCommandGranted()) {
          connection.channels.dropAll();
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
        { channelId, seq }: { channelId: string; seq: number },
        { client }: Options,
      ) =>
        Effect.tap(connectionOf(client.id), underSwitch).pipe(
          Effect.flatMap((connection) =>
            connection.channels.read(channelId, seq),
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
      "link:end": ({ channelId }: { channelId: string }, { client }: Options) =>
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
    // sharing is off: the switches alone.
    const heard = (channel: string) =>
      sharing === undefined || SWITCHES.has(channel)
        ? (pushes: Stream.Stream<unknown>) => pushes
        : Stream.filterEffect(() => sharing.current);

    // A switch's value now, which a peer hears first as it subscribes:
    // one that flipped after the welcome reaches it no other way.
    const switchNow: Record<string, Effect.Effect<boolean>> = local
      ? {}
      : {
          [COMMAND_ACCESS_CHANGED]: Effect.sync(options.isCommandGranted),
          [SHARING_CHANGED]: sharingNow,
        };

    // The host's pushes on `channel`, a switch's from its value now.
    const hostStream = (channel: string) => {
      const now = switchNow[channel];
      return now === undefined
        ? hostPushes.stream(channel)
        : Stream.unwrap(
            Effect.map(hostPushes.subscribe, (pushes) =>
              Stream.concat(
                Stream.fromEffect(now),
                pushes.pipe(
                  Stream.filter((pushed) => pushed.channel === channel),
                  Stream.map((pushed) => pushed.payload),
                ),
              ),
            ),
          );
    };

    // A push: the host's own when it is one every peer may hear
    // (annotated `remote`), and the ones for this peer alone.
    const push =
      (channel: string, toEveryPeer: boolean) =>
      (_: undefined, { client }: Options) =>
        Stream.unwrap(
          Effect.map(connectionOf(client.id), (connection) =>
            Stream.merge(
              toEveryPeer
                ? hostStream(channel).pipe(heard(channel))
                : Stream.empty,
              Stream.fromPubSub(connection.pushes).pipe(
                Stream.filter((entry) => entry.channel === channel),
                Stream.map((entry) => entry.payload),
              ),
            ),
          ),
        ).pipe(boundedMessages);

    // What the link answers itself: its own calls, the pushes, and
    // every call the host's handlers don't serve.
    const servedKeys = served.mapUnsafe;
    const own: Record<string, unknown> = { ...linkHandlers };
    for (const call of group.requests.values()) {
      const tag = channelOf(call);
      if (tag in own) continue;
      if (isPush(call)) {
        own[tag] = push(tag, local || annotation(call, Remote) === true);
      } else if (!servedKeys.has(call.key)) {
        own[tag] = isInvoke(call)
          ? () => Effect.fail(unserved(tag))
          : () => Stream.fail(unserved(tag));
      }
    }
    const ownCalls = [...group.requests.values()].filter(
      (call) => channelOf(call) in own,
    );

    const peerAuth = Layer.succeed(PeerAuth, (effect, { client, rpc }) =>
      Effect.suspend(() => {
        const connection = connections.get(client.id);
        if (connection === undefined || connection.phase.kind !== "linked") {
          return Effect.fail(new LinkUnauthenticatedError());
        }
        const { deviceId, shell } = connection.phase;
        // The shell's session is the shell's alone.
        if (SHELL_SESSION.has(channelOf(rpc as ContractCall)) && !shell) {
          return Effect.fail(new LinkUnauthenticatedError());
        }
        return effect.pipe(
          Effect.provideService(LinkPeer, {
            deviceId: local ? undefined : deviceId,
            closed: connection.closed.signal,
            channels: connection.channels,
            notify: (module, key, payload) => {
              const resolved = resolvePush(module, key, payload);
              PubSub.publishUnsafe(connection.pushes, {
                channel: resolved.channel,
                payload: resolved.payload,
              });
            },
          }),
        );
      }),
    );

    const commandGate = Layer.succeed(CommandGate, (effect, { rpc }) =>
      Effect.gen(function* () {
        // The loopback's callers command this machine as its owner.
        if (local) return yield* effect;
        const peer = yield* LinkPeer;
        // Only an explicit gated:false is a read. A missing
        // annotation is gated like a command.
        if (annotation(rpc as ContractCall, Gated) === false) {
          return yield* effect;
        }
        // Subscribed before the switch is read, so a flip in
        // between is heard: a call or a view under way ends as the
        // switch turns off, and what it set going (a script's
        // console) reaches the peer only while it is on.
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const pushes = yield* hostPushes.subscribe;
            if (!options.isCommandGranted()) {
              return yield* new CommandRefusedError();
            }
            const off = pushes.pipe(
              Stream.filter(
                (published) =>
                  published.channel === COMMAND_ACCESS_CHANGED &&
                  !options.isCommandGranted(),
              ),
              Stream.runHead,
              Effect.andThen(Effect.fail(new CommandRefusedError())),
            );
            return yield* Effect.raceFirst(
              effect.pipe(
                Effect.provideService(LinkPeer, {
                  ...peer,
                  notify: (module, key, said) => {
                    if (options.isCommandGranted()) {
                      peer.notify(module, key, said);
                    }
                  },
                }),
              ),
              off,
            );
          }),
        );
      }),
    );

    const sharingGate = Layer.succeed(SharingGate, (effect, { rpc }) =>
      Effect.gen(function* () {
        const peer = yield* LinkPeer;
        if (channelOf(rpc).startsWith("link:") || isPush(rpc as ContractCall)) {
          return yield* effect;
        }
        if (sharing === undefined || !(yield* sharing.current)) {
          return yield* new NotSharingError();
        }
        const shared = sharing;
        // A call or a view under way ends as the switch turns off,
        // and what it set going reaches the peer only while it is on.
        const off = shared.changes.pipe(
          Stream.filter((on) => !on),
          Stream.runHead,
          Effect.andThen(Effect.fail(new NotSharingError())),
        );
        return yield* Effect.raceFirst(
          effect.pipe(
            Effect.provideService(LinkPeer, {
              ...peer,
              notify: (module, key, said) => {
                if (shared.now()) {
                  peer.notify(module, key, said);
                }
              },
            }),
          ),
          off,
        );
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
          Layer.succeedContext(served),
          RpcGroup.make(...ownCalls).toLayer(Effect.succeed(own as never)),
          peerAuth,
          sharingGate,
          commandGate,
          Layer.succeed(RpcServer.Protocol, protocol),
        ),
      ),
      Effect.forkScoped,
    );

    // A connection's frames into the RPC server, until it closes.
    const serveConnection = (clientId: number, connection: Connection) =>
      Effect.gen(function* () {
        const socket = yield* Socket.fromWebSocket(
          Effect.succeed(connection.wire),
        );
        const { pull } = yield* socket.reader;
        while (true) {
          const frames = yield* pull;
          for (const frame of frames) {
            if (connection.phase.kind === "dead") return;
            const messages = decodeFrame(connection.parser, frame);
            // A socket is a stream: a parser that failed can't find
            // the next frame, so every later one would fail while the
            // link stayed up answering nothing. The connection goes,
            // and the far end dials again.
            if (Result.isFailure(messages)) {
              log.warn(
                `[link] an unreadable frame, closing the connection (${frameWords(frame, messages.failure)})`,
              );
              connection.kill(CLOSE_UNREADABLE, "an unreadable frame");
              return;
            }
            for (const message of messages.success) {
              yield* server.request(clientId, message);
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
            server.disconnected(clientId);
          }),
        ),
      );

    if (!local)
      yield* Stream.merge(
        hostPushes
          .stream(COMMAND_ACCESS_CHANGED)
          .pipe(Stream.filter(() => !options.isCommandGranted())),
        sharing === undefined
          ? Stream.empty
          : sharing.changes.pipe(Stream.filter((on) => !on)),
      ).pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            for (const connection of connections.values()) {
              connection.channels.dropAll();
            }
          }),
        ),
        Effect.forkScoped,
      );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const connection of connections.values()) {
          connection.kill(CLOSE_GOING_AWAY, "server stopping");
        }
      }),
    );

    return {
      accept: (wire, { from, peer, cut }) =>
        Effect.gen(function* () {
          const clientId = nextClientId++;
          const pushes = yield* PubSub.sliding<Push>(1024);
          const connection: Connection = {
            wire,
            from,
            channels: makeHostChannels(),
            pushes,
            closed: new AbortController(),
            parser: server.parser(),
            phase:
              peer === undefined
                ? { kind: "preAuth" }
                : { kind: "linked", deviceId: peer, shell: false },
            kill(code, reason) {
              if (connection.phase.kind === "dead") return;
              connection.phase = { kind: "dead" };
              connection.channels.closeAll();
              connection.closed.abort();
              cut(code, reason);
            },
          };
          connections.set(clientId, connection);
          // A hello arriving after this does not count.
          if (peer === undefined) {
            setTimeout(() => {
              if (connection.phase.kind === "preAuth") {
                connection.kill(CLOSE_HELLO_FAILED, "hello timeout");
              }
            }, HELLO_TIMEOUT_MS).unref();
          }
          yield* serveConnection(clientId, connection);
        }),
    } satisfies LinkServer;
  });

export class DeviceLink extends Context.Service<
  DeviceLink,
  {
    // A dialer's greeting answered: this host's welcome, or its refusal
    // of a build on another core.
    readonly admit: (
      hello: IncomingHello,
    ) => Effect.Effect<Uint8Array, AppRefusal>;
    // A peer's link, served until it closes.
    readonly serve: (link: Link) => Effect.Effect<void>;
  }
>()("sm/host/DeviceLink") {}

export const layer = (options: { readonly isCommandGranted: () => boolean }) =>
  Layer.effect(
    DeviceLink,
    Effect.gen(function* () {
      const sharing = yield* Sharing.Sharing;
      const facts = yield* HostFacts.HostFacts;
      const server = yield* makeServer({
        deviceId: yield* DeviceId.current,
        appVersion: facts.appVersion,
        isCommandGranted: options.isCommandGranted,
        sharing,
      });
      return DeviceLink.of({
        admit: Effect.fn("DeviceLink.admit")(function* (incoming) {
          const hello = decodeHello(incoming.appHello);
          if (hello === null) {
            return yield* new AppRefusal({ reason: "an unreadable hello" });
          }
          if (hello.coreVersion !== CORE_VERSION) {
            return yield* new AppRefusal({
              reason: "protocol version mismatch",
              appRefusal: encodeRefusal(hello.coreVersion),
            });
          }
          return encodeWelcome({
            appVersion: facts.appVersion,
            versions: versionsOf(LinkGroup),
            acceptsCommands: options.isCommandGranted(),
            sharesData: yield* sharing.current,
          });
        }),
        serve: Effect.fn("DeviceLink.serve")(function* (link) {
          const wire = yield* linkSocket(link);
          log.info(`[link] ${link.deviceId} linked over ${link.arrival}`);
          yield* server.accept(wire, {
            from: `${link.deviceId} over ${link.arrival}`,
            peer: link.deviceId,
            cut: () => wire.close(),
          });
        }, Effect.scoped),
      });
    }),
  );
