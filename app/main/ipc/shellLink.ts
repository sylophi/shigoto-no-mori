// The shell's end of each window's link (shared/ipc/shell.ts): Effect
// RPC over a MessagePort, serving the client modules this process owns
// (dialogs, the window, the menu, the account, the client config) to the
// window the port was handed to. Every window that loads asks the
// preload for a port, the preload asks here (attach), and a page that
// goes takes its port with it.
import { channelOf, isBroadcast } from "@shigomori/contracts/contract";
import { callFailureOf, RemoteCallError } from "@shigomori/contracts/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import type { MessagePortMain, WebContents } from "electron";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import { ShellGroup } from "@shared/ipc/shell";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import { log } from "@shared/log";
import { portSocket } from "@shared/remote/portSocket";
import * as PromiseAdapter from "@host/lib/util/promiseAdapter";

type Push = { readonly channel: string; readonly payload: unknown };
type Served = (ctx: HandlerContext, input: unknown) => Promise<unknown>;

// What the shell registers to serve, by channel, and the pushes it fans
// out to every window. Registration comes first, at boot; the server
// reads it once each port is attached.
export type ShellRegistrar = ServerTransport & {
  readonly served: ReadonlyMap<string, Served>;
  readonly pushes: PubSub.PubSub<Push>;
};

export function createShellRegistrar(): ShellRegistrar {
  const served = new Map<string, Served>();
  const pushes = Effect.runSync(PubSub.unbounded<Push>());
  return {
    served,
    pushes,
    handle(channel, fn) {
      if (served.has(channel)) {
        throw new Error(`[shell] "${channel}" is served already`);
      }
      served.set(channel, fn);
    },
    broadcastAll(channel, payload) {
      PubSub.publishUnsafe(pushes, { channel, payload });
    },
  };
}

export class ShellLink extends Context.Service<
  ShellLink,
  {
    // Serves the shell's calls on `port`, to the window `webContents`
    // shows, until the port closes.
    readonly attach: (
      port: MessagePortMain,
      webContents: WebContents,
    ) => Effect.Effect<void>;
    // A push for one window alone (its menu's events, its focus).
    readonly pushTo: (
      webContents: WebContents,
      push: Push,
    ) => Effect.Effect<void>;
  }
>()("sm/shell/ShellLink") {}

type Connection = {
  readonly socket: Socket.WebSocketLike;
  readonly parser: RpcSerialization.Parser;
  readonly webContents: WebContents | null;
  readonly pushes: PubSub.PubSub<Push>;
  readonly closed: AbortController;
};

// A port's far end, as Electron's main process holds it.
type MainPort = Pick<MessagePortMain, "postMessage" | "close" | "on" | "start">;

type Group = RpcGroup.RpcGroup<Rpc.AnyWithProps>;

// Serves `group`'s calls from `registrar` on every port attached, until
// it closes: the windows' shell ports (ShellLink below), and the port
// the shell hands its host (main/hostProcess.ts).
export const makePortServer = (registrar: ShellRegistrar, group: Group) =>
  Effect.gen(function* () {
    const runFork = yield* FiberSet.makeRuntime<never>();
    const serialization = yield* RpcSerialization.RpcSerialization.pipe(
      Effect.provide(RpcSerialization.layerSchemaBinary()),
    );
    const connections = new Map<number, Connection>();
    let nextClientId = 0;
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
            const encoded = connection?.parser.encode(response);
            if (connection === undefined || encoded === undefined) return;
            if (connection.socket.readyState === 1) {
              connection.socket.send(encoded as Uint8Array<ArrayBuffer>);
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

    type Options = { readonly client: { readonly id: number } };
    const connectionOf = (clientId: number) =>
      Effect.suspend(() => {
        const connection = connections.get(clientId);
        return connection === undefined
          ? Effect.die(new Error("a call came on no window's port"))
          : Effect.succeed(connection);
      });

    // A call: the registered handler, its signal aborted when the call
    // is interrupted, its failure crossing as the contract error it is,
    // or as RemoteCallError with its message and code.
    const serve =
      (fn: Served) =>
      (payload: unknown, { client }: Options) =>
        Effect.flatMap(connectionOf(client.id), (connection) =>
          Effect.tryPromise({
            try: (signal) =>
              fn(
                {
                  signal,
                  connection: connection.closed.signal,
                  notifier: (module, key) => (push) => {
                    const { channel, parsed } = resolveBroadcast(
                      module,
                      key,
                      push,
                    );
                    PubSub.publishUnsafe(connection.pushes, {
                      channel,
                      payload: parsed,
                    });
                  },
                },
                payload,
              ),
            catch: callFailureOf,
          }),
        );

    // A push: every window's, and this window's own.
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

    const handlers: Record<string, unknown> = {};
    for (const call of group.requests.values()) {
      const channel = channelOf(call);
      if (isBroadcast(call)) {
        handlers[channel] = push(channel);
        continue;
      }
      const fn = registrar.served.get(channel);
      handlers[channel] =
        fn === undefined
          ? () =>
              Effect.fail(
                new RemoteCallError({
                  text: `No handler registered for channel "${channel}"`,
                }),
              )
          : serve(fn);
    }

    yield* RpcServer.make(group, {
      spanPrefix: "Shell",
      disableFatalDefects: true,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayer(Effect.succeed(handlers as never)),
          Layer.succeed(RpcServer.Protocol, protocol),
        ),
      ),
      Effect.forkScoped,
    );

    const serveSocket = (clientId: number, connection: Connection) =>
      Effect.gen(function* () {
        const socket = yield* Socket.fromWebSocket(
          Effect.succeed(connection.socket),
        );
        const { pull } = yield* socket.reader;
        while (true) {
          for (const frame of yield* pull) {
            for (const message of decodeFrame(connection.parser, frame)) {
              yield* writeRequest(clientId, message);
            }
          }
        }
      }).pipe(
        Effect.scoped,
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            connection.closed.abort();
            connections.delete(clientId);
            Queue.offerUnsafe(disconnects, clientId);
          }),
        ),
      );

    return {
      attach: (port: MainPort, webContents: WebContents | null) => {
        const closed = new AbortController();
        return Effect.gen(function* () {
          const clientId = nextClientId++;
          const connection: Connection = {
            socket: portSocket({
              // A frame is a view into a buffer the encoder goes on
              // writing, which a port would clone whole: only its own
              // bytes go.
              postMessage: (data) => port.postMessage(data.slice()),
              close: () => port.close(),
              listen: (onMessage, onClose) => {
                port.on("message", (event) => onMessage(event.data));
                port.on("close", onClose);
                port.start();
              },
            }),
            parser: serialization.makeUnsafe(),
            webContents,
            pushes: yield* PubSub.sliding<Push>(1024),
            closed,
          };
          connections.set(clientId, connection);
          runFork(serveSocket(clientId, connection));
        });
      },
      pushTo: (webContents: WebContents, entry: Push) =>
        Effect.sync(() => {
          for (const connection of connections.values()) {
            if (connection.webContents === webContents) {
              PubSub.publishUnsafe(connection.pushes, entry);
            }
          }
        }),
    };
  });

// One malformed frame is dropped rather than taking down the window's
// other calls.
function decodeFrame(
  parser: RpcSerialization.Parser,
  frame: Uint8Array | string,
): ReadonlyArray<RpcMessage.FromClientEncoded> {
  try {
    return parser.decode(frame) as ReadonlyArray<RpcMessage.FromClientEncoded>;
  } catch {
    log.warn("[shell] dropping an unparseable frame");
    return [];
  }
}

export const layer = (registrar: ShellRegistrar) =>
  Layer.effect(
    ShellLink,
    Effect.map(makePortServer(registrar, ShellGroup), ShellLink.of),
  );

const promiseAdapter = PromiseAdapter.forService(ShellLink, "The shell link");
export const adapter = promiseAdapter.layer;

// The Promise face, for main/ipc/register.ts and the window's creation.
export const shellLink = {
  attach: (port: MessagePortMain, webContents: WebContents) =>
    promiseAdapter.call((link) => link.attach(port, webContents)),
  pushTo: (webContents: WebContents, push: Push) =>
    promiseAdapter.runIfOpen(
      Effect.flatMap(ShellLink, (link) => link.pushTo(webContents, push)),
    ),
};
