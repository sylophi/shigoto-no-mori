// The contract clients' RpcClient over one socket, for every link that
// dials one: a device's or the loopback's (app/shared/remote/
// deviceLink.ts), a MessagePort's (portLink.ts), the terminal's to the
// app (packages/cli/src/Control.ts).
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { type ContractCall, isInvoke } from "@shigomori/contracts/contract";
import { LINK_MAX_FRAME_BYTES, outdatedCall } from "@shigomori/contracts/link";
import type { Welcome } from "@shigomori/contracts/modules/link";

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
// an idle hour would cut links both ends still serve (EFFECT.md,
// section 8). A link to another machine is judged by watchLiveness
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

// A client that sends a host only what its build reads: a call into a
// module its welcome named at another version fails here, unsent, with
// the refusal (contracts' link.ts, outdatedCall). A push of such a
// module is never asked for either, since a push is a call.
export const versionedClient =
  (
    client: FlatClient,
    group: { readonly requests: ReadonlyMap<string, ContractCall> },
    host: Pick<Welcome, "deviceId" | "versions">,
  ): FlatClient =>
  (tag, payload, options) => {
    const call = group.requests.get(tag);
    const refusal = call === undefined ? undefined : outdatedCall(call, host);
    if (call === undefined || refusal === undefined) {
      return client(tag, payload, options);
    }
    return isInvoke(call) ? Effect.fail(refusal) : Stream.fail(refusal);
  };

// A connection's id, which the far end tells it apart by: 16 random
// bytes as hex.
export const newConnectionId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
