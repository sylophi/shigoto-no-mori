// The contract clients' RpcClient over one socket, for every link that
// dials one: a device's or the loopback's (app/shared/remote/
// deviceLink.ts), a MessagePort's (portLink.ts), the terminal's to the
// app (Control.ts).
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import type * as Stream from "effect/Stream";
import { LINK_MAX_FRAME_BYTES } from "@shigomori/contracts/link";

// A group's calls as its flat client knows them: a tag and a payload,
// and an Effect or a Stream back.
export type FlatClient = (
  tag: string,
  payload: unknown,
  options?: object,
) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>;

// The protocol over `socket`, which never gives the link up on its
// pings: Effect's pinger condemns a link on the age of the last frame
// before it sends, on the wall clock, so a sleep, a stopped process or
// an idle hour cut links both ends still served (V3.md, "Local links
// and liveness"). A link to another machine is judged by watchLiveness
// (liveness.ts), one to this machine's own app by nothing here. Pings
// still go every `pingInterval`, for a far end that times a quiet link
// out. One socket, no redial: a dropped link is its owner's to dial
// again.
export const quietProtocol = (
  socket: Socket.Socket,
  options: {
    readonly pingInterval?: Duration.Input;
    readonly hooks?: RpcClient.ConnectionHooks["Service"];
  } = {},
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.makeProtocolSocket({
    pingInterval: options.pingInterval ?? "1 hour",
    pingTimeout: Duration.infinity,
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provide(
      Layer.mergeAll(
        RpcSerialization.layerSchemaBinary({
          maxFrameSize: LINK_MAX_FRAME_BYTES,
        }),
        options.hooks === undefined
          ? Layer.empty
          : Layer.succeed(RpcClient.ConnectionHooks, options.hooks),
      ),
    ),
  );

// The group's flat client over `protocol`. The group is built from the
// contract's calls as they are listed, so its client knows each call
// only as some call.
export const flatClient = (
  group: RpcGroup.Any,
  protocol: RpcClient.Protocol["Service"],
): Effect.Effect<FlatClient, never, Scope.Scope> =>
  // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
  RpcClient.make(group as never, { flatten: true }).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  ) as unknown as Effect.Effect<FlatClient, never, Scope.Scope>;

// A connection's id, which the far end tells it apart by: 16 random
// bytes as hex.
export const newConnectionId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
