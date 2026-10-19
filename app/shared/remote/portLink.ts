// The contract clients' link over a MessagePort (portSocket.ts), for as
// long as the port lives: the window's link to its shell
// (shared/ipc/shell.ts), and the host's to the shell that started it
// (host/process/shell.ts). The far end serves it with
// main/ipc/ShellLink.ts.
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import type { ContractCall } from "@shigomori/contracts/contract";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { Link } from "@shared/ipc/transport";
import { type PortEnds, portSocket } from "./portSocket";
import { rpcLink } from "./rpcTransport";
import { flatClient, quietProtocol } from "@shigomori/engine/rpcClient";

type ContractGroup = RpcGroup.Any & {
  readonly requests: ReadonlyMap<string, ContractCall>;
};

export const portLink = Effect.fnUntraced(function* (
  ends: PortEnds,
  group: ContractGroup,
): Effect.fn.Return<Link, never, Scope.Scope> {
  // The far end is a process of this app on this machine: it answers
  // or is gone with the port, so silence proves nothing.
  const protocol = yield* quietProtocol(
    yield* Socket.fromWebSocket(Effect.succeed(portSocket(ends))),
  );
  const client = yield* flatClient(group, protocol);
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
