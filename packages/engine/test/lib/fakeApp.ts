// A loopback listener that plays the running app on the device link's
// loopback, scripted: it serves the link's handshake under TOKEN, then
// answers each control call with the frames `reply` returns for it: its
// progress pushes, then its answer. A reply with no answer drops the
// connection. The engine and the terminal binary dial it.
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { LinkRefusedError, RemoteCallError } from "@shigomori/contracts/errors";
import {
  CommandGate,
  LinkPeer,
  LoopbackGroup,
  PeerAuth,
} from "@shigomori/contracts/link";
import { channelOf, isInvoke } from "@shigomori/contracts/contract";
import {
  handshakeProof,
  newHandshakeNonce,
  proofsMatch,
} from "@shigomori/contracts/proof";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";

export type Frame = Readonly<Record<string, unknown>>;

// A control call as the app received it.
type Received = {
  readonly request: { readonly channel: string; readonly input?: unknown };
};

export const TOKEN = "good-token";

export type FakeApp = {
  readonly port: number;
  // loopback.json naming this listener, as the app publishes it.
  readonly file: (token?: string) => Frame;
  // The control calls since the last look, in order.
  readonly received: () => ReadonlyArray<Received>;
  readonly close: () => Promise<void>;
};

// The answer to a call.
export const success = (_request: Frame, result: unknown): Frame => ({
  t: "res",
  ok: true,
  result,
});

// The app's refusal, with its code.
export const refusal = (
  _request: Frame,
  message: string,
  code?: string,
): Frame => ({
  t: "res",
  ok: false,
  message,
  ...(code === undefined ? {} : { code }),
});

export const progress = (payload: unknown): Frame => ({
  t: "push",
  channel: "sync:pullProgress",
  payload,
});

const PROGRESS = "sync:pullProgress";

// `busy` turns every connection away as an app at its cap does.
export const fakeApp = async (
  reply: (request: Frame) => ReadonlyArray<Frame>,
  options: { readonly busy?: boolean } = {},
): Promise<FakeApp> => {
  let seen: Received[] = [];
  const scope = Effect.runSync(Scope.make());
  const nonces = new Map<number, string>();
  // Ends the listener and every connection, as an app that went away.
  const dropAll = Effect.suspend(() =>
    Effect.forkDetach(Scope.close(scope, Exit.void)),
  );

  type Options = { readonly client: { readonly id: number } };
  const handlers: Record<string, unknown> = {};
  for (const call of LoopbackGroup.requests.values()) {
    const tag = channelOf(call);
    const unserved = new RemoteCallError({ text: `no handler for ${tag}` });
    handlers[tag] = isInvoke(call)
      ? () => Effect.fail(unserved)
      : () => Stream.fail(unserved);
  }
  handlers["link:challenge"] = (_: undefined, { client }: Options) =>
    Effect.sync(() => {
      const nonce = newHandshakeNonce();
      nonces.set(client.id, nonce);
      return { nonce };
    });
  handlers["link:hello"] = (
    hello: { readonly nonce: string; readonly proof: string },
    { client }: Options,
  ) =>
    Effect.gen(function* () {
      const hostNonce = nonces.get(client.id) ?? "";
      const want = yield* Effect.promise(() =>
        handshakeProof(TOKEN, "client", hostNonce, hello.nonce),
      );
      if (!proofsMatch(hello.proof, want)) {
        return yield* new LinkRefusedError();
      }
      return {
        deviceId: "app-device",
        appVersion: "1.2.3",
        proof: yield* Effect.promise(() =>
          handshakeProof(TOKEN, "host", hostNonce, hello.nonce),
        ),
      };
    });
  handlers["link:ping"] = () => Effect.void;

  // The scripted answer, as the frames `reply` returns for the call.
  const answer = (tag: string, input: unknown) => {
    seen.push({
      request: input === undefined ? { channel: tag } : { channel: tag, input },
    });
    const frames = reply({ channel: tag, input });
    const result = frames.find((frame) => frame["t"] === "res");
    const failure =
      result === undefined || result["ok"] === true
        ? undefined
        : new RemoteCallError({
            text: String(result["message"] ?? ""),
            ...(typeof result["code"] === "string"
              ? { code: result["code"] }
              : {}),
          });
    return { frames, result, failure };
  };
  for (const call of LoopbackGroup.requests.values()) {
    const tag = channelOf(call);
    if (!tag.startsWith("control:")) continue;
    handlers[tag] = isInvoke(call)
      ? (input: unknown) =>
          Effect.gen(function* () {
            const { result, failure } = answer(tag, input);
            if (result === undefined) {
              yield* dropAll;
              return yield* Effect.never;
            }
            if (failure !== undefined) return yield* failure;
            return result["result"];
          })
      : // A transfer: its progress, then its answer, on one stream.
        (input: unknown) =>
          Stream.unwrap(
            Effect.sync(() => {
              const { frames, result, failure } = answer(tag, input);
              const steps = Stream.fromIterable(
                frames
                  .filter(
                    (frame) =>
                      frame["t"] === "push" && frame["channel"] === PROGRESS,
                  )
                  .map((frame) => ({
                    _tag: "progress" as const,
                    progress: frame["payload"],
                  })),
              );
              const end =
                result === undefined
                  ? Stream.fromEffect(Effect.andThen(dropAll, Effect.never))
                  : failure !== undefined
                    ? Stream.fail(failure)
                    : Stream.succeed({
                        _tag: "result" as const,
                        result: result["result"],
                      });
              return Stream.concat(steps, end);
            }),
          );
  }

  // The socket server, which turns each connection away at once when
  // `busy`.
  const socketServer = Layer.effect(
    SocketServer.SocketServer,
    Effect.gen(function* () {
      const inner = yield* NodeSocketServer.makeWebSocket({
        host: "127.0.0.1",
        port: 0,
      });
      return SocketServer.SocketServer.of({
        address: inner.address,
        run: (handler) =>
          inner.run((socket) =>
            options.busy === true
              ? Effect.scoped(
                  // The writer waits for a reader to hold the socket.
                  Effect.andThen(socket.reader, socket.writer).pipe(
                    Effect.flatMap(({ write }) =>
                      write(new Socket.CloseEvent(1013, "busy")),
                    ),
                  ),
                ).pipe(Effect.ignore)
              : Effect.asVoid(handler(socket)),
          ),
      });
    }),
  );

  const context = await Effect.runPromise(
    Layer.buildWithScope(socketServer, scope),
  );
  const port = await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* SocketServer.SocketServer;
      yield* RpcServer.make(LoopbackGroup, { disableFatalDefects: true }).pipe(
        Effect.provide(
          Layer.mergeAll(
            LoopbackGroup.toLayer(Effect.succeed(handlers as never)),
            Layer.succeed(PeerAuth, (effect) =>
              effect.pipe(
                Effect.provideService(LinkPeer, {
                  deviceId: undefined,
                  closed: new AbortController().signal,
                  channels: {
                    attach: () => {
                      throw new Error("no channels here");
                    },
                    has: () => false,
                    size: () => 0,
                  },
                  notify: () => {},
                }),
              ),
            ),
            Layer.succeed(CommandGate, (effect) => effect),
            RpcServer.layerProtocolSocketServer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(SocketServer.SocketServer, server),
                  RpcSerialization.layerSchemaBinary(),
                ),
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const address = server.address;
      return "port" in address ? address.port : 0;
    }).pipe(Effect.provideContext(context), Scope.provide(scope)),
  );
  return {
    port,
    file: (token = TOKEN) => ({
      pid: process.pid,
      port,
      token,
      appVersion: "1.2.3",
    }),
    received: () => {
      const taken = seen;
      seen = [];
      return taken;
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};
