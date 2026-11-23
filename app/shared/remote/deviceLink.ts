// The dialing side of a link (link.ts): an RpcClient over one socket,
// and then the far end's calls, views and pushes as a Link, and its
// byte channels. A peer's socket is a Colibrii link (linkSocket.ts),
// whose greeting carried the welcome. The loopback's is a WebSocket to
// this machine's own host, which welcomes the token its hello carries.
// It runs in the host and, verbatim, in the web client.
//
// A link that drops stays dropped: redials live one layer up, in the
// peer keeper (shared/hub/directKeeper.ts) and the host link
// (hostLink.ts).
import {
  errorMessageOf,
  LinkRefusedError,
  ModuleOutdatedError,
} from "@shigomori/contracts/errors";
import { CORE_VERSION } from "@shigomori/contracts/protocol";
import type { Link as ColibriiLink } from "@colibrii/sdk";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FiberSet from "effect/FiberSet";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import type * as Scope from "effect/Scope";
import type { Link } from "@shared/ipc/transport";
import {
  type LinkChannels,
  LinkGroup,
  type OutdatedModules,
  outdatedModules,
  versionsOf,
} from "@shigomori/contracts/link";
import { isInvoke, moduleOf } from "@shigomori/contracts/contract";
import type { PeerWelcome, Welcome } from "@shigomori/contracts/modules/link";
import { createChannelMux } from "./channels";
import {
  type FlatClient,
  flatClient,
  newConnectionId,
  quietProtocol,
} from "@shigomori/engine/rpcClient";
import { linkSocket } from "./linkSocket";
import { rpcLink } from "./rpcTransport";

// A loopback dial that failed before its link was up.
export class RemoteConnectError extends Data.TaggedError("RemoteConnectError")<{
  readonly message: string;
}> {}

// What a loopback link is opened with: the browser's WebSocket, or the
// `ws` package, which names the errno a failed dial died of where the
// platform global reports a bare 1006.
export type OpenClientSocket = (url: string) => Socket.WebSocketLike;

// A link up in the caller's scope until the scope closes or the link
// drops (`dropped`).
export type DialedDevice = {
  readonly link: Link;
  // The port-forward engine and the mirror gateway attach their local
  // sockets here, under ids they mint, before opening the far end.
  readonly channels: LinkChannels;
  readonly remoteAppVersion: string;
  // What of the far end this link refuses, when the two are builds of
  // different releases.
  readonly outdated: OutdatedModules | undefined;
  // Settles when the link drops on its own.
  readonly dropped: Effect.Effect<void>;
};

type LinkOptions = {
  // Every push the far end sends, by channel, decoded.
  readonly onPush?: ((channel: string, payload: unknown) => void) | undefined;
  readonly localDeviceId: string;
};

// The link over an open socket, once `greet` has the far end's welcome.
const linkOver = <E>(
  wire: Socket.WebSocketLike,
  options: LinkOptions & {
    readonly group: typeof LinkGroup;
    readonly local: boolean;
    readonly greet: (
      call: (tag: string, payload: unknown) => Effect.Effect<unknown, unknown>,
    ) => Effect.Effect<
      { readonly deviceId: string } & Pick<Welcome, "appVersion" | "versions">,
      E
    >;
  },
) =>
  Effect.gen(function* () {
    const { group } = options;
    const dropped = yield* Deferred.make<void>();
    const socket = yield* Socket.fromWebSocket(Effect.succeed(wire));
    const socketProtocol = yield* quietProtocol(socket, {
      hooks: {
        onConnect: Effect.void,
        onDisconnect: Deferred.succeed(dropped, undefined),
      },
    });
    // A frame this end cannot decode (one past LINK_MAX_FRAME_BYTES)
    // leaves the RPC client's parser unable to find the next, so every
    // later answer fails too while the socket stays up (Effect's
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

    const welcome = yield* options.greet(call);
    const outdated = outdatedModules(versionsOf(group), welcome.versions);
    const link = yield* rpcLink({
      client:
        outdated === undefined
          ? client
          : refusing(client, group, outdated, {
              this: options.localDeviceId,
              peer: welcome.deviceId,
            }),
      group,
      onPush: options.onPush,
      local: options.local,
    });

    // A round trip behind the subscriptions, so the link counts as open
    // only once the far end hears it for its pushes: it serves a link's
    // calls in the order they arrive.
    yield* call("link:ping", undefined);

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
      channels,
      remoteAppVersion: welcome.appVersion,
      outdated,
      dropped: Deferred.await(dropped),
    } satisfies DialedDevice;
  });

// A link to a peer over the Colibrii link dialed to it, whose welcome
// its greeting carried.
export const peerLink = (
  link: ColibriiLink,
  welcome: PeerWelcome,
  options: LinkOptions,
): Effect.Effect<DialedDevice, unknown, Scope.Scope> =>
  Effect.flatMap(linkSocket(link), (wire) =>
    linkOver(wire, {
      ...options,
      group: LinkGroup,
      local: false,
      greet: () => Effect.succeed({ ...welcome, deviceId: link.deviceId }),
    }),
  );

// A link to this machine's own host, on the loopback.
export const dialHost = (
  options: LinkOptions & {
    readonly url: string;
    readonly token: string;
    readonly appVersion: string;
    readonly openSocket: OpenClientSocket;
    // How long the whole dial may take, the socket's open included.
    readonly deadlineMs: number;
    readonly group: typeof LinkGroup;
  },
): Effect.Effect<DialedDevice, RemoteConnectError, Scope.Scope> => {
  // Whatever the platform said about why the socket failed (`ws` names
  // the errno), for the dial's failure message.
  let errorDetail = "";
  const connectError = (message: string) =>
    new RemoteConnectError({
      message: errorDetail === "" ? message : `${message} (${errorDetail})`,
    });

  return Effect.gen(function* () {
    const ws = options.openSocket(options.url);
    ws.addEventListener("error", (event) => {
      const cause = (event as { error?: unknown }).error;
      const detail =
        cause instanceof Error &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : cause instanceof Error
            ? cause.message
            : "";
      if (detail !== "") errorDetail = detail;
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
    const open = yield* Deferred.make<void>();
    if (ws.readyState === 1) Deferred.doneUnsafe(open, Exit.void);
    else {
      ws.addEventListener("open", () => Deferred.doneUnsafe(open, Exit.void), {
        once: true,
      });
    }
    yield* Deferred.await(open).pipe(
      Effect.timeoutOrElse({
        duration: options.deadlineMs,
        orElse: () => Effect.fail(connectError("the socket did not open")),
      }),
    );
    return yield* linkOver(ws, {
      ...options,
      local: true,
      greet: (call) =>
        call("link:hello", {
          deviceId: options.localDeviceId,
          deviceKind: "desktop",
          connectionId: newConnectionId(),
          appVersion: options.appVersion,
          protocolVersion: CORE_VERSION,
          token: options.token,
        }).pipe(
          Effect.map((welcome) => welcome as Welcome),
          Effect.mapError((error) =>
            error instanceof LinkRefusedError
              ? connectError("the host refused the token")
              : connectError(`the hello failed: ${errorMessageOf(error)}`),
          ),
        ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.deadlineMs,
        orElse: () => Effect.fail(connectError("the host did not answer")),
      }),
    );
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

// A client that sends the host nothing of the modules the two builds
// hold at different versions: a call into one fails here, unsent, and a
// push of one is never asked for, since a push is a call.
function refusing(
  client: FlatClient,
  group: typeof LinkGroup,
  outdated: OutdatedModules,
  ends: { readonly this: string; readonly peer: string },
): FlatClient {
  const [older, newer] =
    outdated.outdated === "peer"
      ? [ends.peer, ends.this]
      : [ends.this, ends.peer];
  return (tag, payload, options) => {
    const call = group.requests.get(tag);
    if (call === undefined || !outdated.modules.includes(moduleOf(call))) {
      return client(tag, payload, options);
    }
    const refusal = new ModuleOutdatedError({
      module: moduleOf(call),
      older,
      newer,
    });
    return isInvoke(call) ? Effect.fail(refusal) : Stream.fail(refusal);
  };
}
