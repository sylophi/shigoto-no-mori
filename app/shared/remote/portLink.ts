// The contract clients' link over a MessagePort (portSocket.ts), for as
// long as the port lives: the window's link to its shell
// (shared/ipc/shell.ts), and the host's to the shell that started it
// (host/process/shell.ts). The far end serves it with
// main/ipc/ShellLink.ts.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import type { ContractCall } from "@shigomori/contracts/contract";
import { LINK_MAX_FRAME_BYTES } from "@shigomori/contracts/link";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { Link } from "@shared/ipc/transport";
import { type PortEnds, portSocket } from "./portSocket";
import { type FlatClient, rpcLink } from "./rpcTransport";

type ContractGroup = RpcGroup.Any & {
  readonly requests: ReadonlyMap<string, ContractCall>;
};

export const portLink = Effect.fnUntraced(function* (
  ends: PortEnds,
  group: ContractGroup,
): Effect.fn.Return<Link, never, Scope.Scope> {
  const socket = portSocket(ends);
  const protocol = yield* RpcClient.makeProtocolSocket({
    // The far end is a process of this app on this machine: it
    // answers or is gone with the port, so silence proves nothing.
    // Effect's pinger, left its default timeout (the interval), read
    // the wall clock and gave the port up for good after an idle hour
    // or a sleep (V3.md, "Local links and liveness").
    pingInterval: "1 hour",
    pingTimeout: Duration.infinity,
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Effect.provideService(
      Socket.Socket,
      yield* Socket.fromWebSocket(Effect.succeed(socket)),
    ),
    Effect.provide(
      RpcSerialization.layerSchemaBinary({
        maxFrameSize: LINK_MAX_FRAME_BYTES,
      }),
    ),
  );
  // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
  const client = (yield* RpcClient.make(group as never, {
    flatten: true,
  }).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )) as unknown as FlatClient;
  return yield* rpcLink({ client, group, local: true });
});

// The link for as long as the process lives: the host's to the shell
// that started it.
export function openPortLink(
  ends: PortEnds,
  group: ContractGroup,
): Promise<Link> {
  return Effect.runPromise(
    portLink(ends, group).pipe(Scope.provide(Scope.makeUnsafe())),
  );
}
