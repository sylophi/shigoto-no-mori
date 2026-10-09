// The desktop window's calls to its shell: the client modules whose
// state is the window's own machine as Electron sees it (dialogs, the
// window, the menu, the account, the client config). The rest, the
// host's, ride the loopback (@shigomori/contracts/link, LoopbackGroup).
// Effect RPC over a MessagePort the preload hands the window
// (main/preload.ts), served by main/ipc/shellLink.ts.
import { allContractModules } from "@shigomori/contracts/allModules";
import { callsOf } from "@shigomori/contracts/contract";
import { isHostSide } from "@shigomori/contracts/link";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import type { ClientTransport } from "@shared/ipc/transport";
import { portSocket } from "@shared/remote/portSocket";
import { type FlatClient, rpcTransport } from "@shared/remote/rpcTransport";

// The message that asks main for the page's port, and that hands it
// to the page.
export const SHELL_PORT_CHANNEL = "shell:port";

export const ShellGroup = RpcGroup.make(
  ...allContractModules
    .filter((module) => !isHostSide(module))
    .flatMap((module) => callsOf(module)),
);

// The window's end: the contract clients' transport over the port the
// preload handed over, for as long as the page lives.
export function openShellLink(port: MessagePort): Promise<ClientTransport> {
  const socket = portSocket({
    // A frame is a view into a buffer the encoder goes on writing, which
    // a port would clone whole: only its own bytes go.
    postMessage: (data) => port.postMessage(data.slice()),
    close: () => port.close(),
    listen: (onMessage, onClose) => {
      port.addEventListener("message", (event) => onMessage(event.data));
      port.addEventListener("close", onClose);
      port.start();
    },
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const runFork = yield* FiberSet.makeRuntime<never>();
      const protocol = yield* RpcClient.makeProtocolSocket({
        // The shell is the window's own process: it answers or the
        // window is gone with it.
        pingInterval: "1 hour",
        retryPolicy: Schedule.recurs(0),
      }).pipe(
        Effect.provideService(
          Socket.Socket,
          yield* Socket.fromWebSocket(Effect.succeed(socket)),
        ),
        Effect.provide(RpcSerialization.layerSchemaBinary()),
      );
      // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
      const client = (yield* RpcClient.make(ShellGroup, { flatten: true }).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      )) as unknown as FlatClient;
      return rpcTransport({
        client,
        group: ShellGroup,
        fork: (effect) => runFork(effect),
      });
    }).pipe(Scope.provide(Scope.makeUnsafe())),
  );
}
