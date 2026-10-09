// The desktop window's calls to its shell: the client modules whose
// state is the window's own machine as Electron sees it (dialogs, the
// window, the menu, the account, the client config). The rest, the
// host's, ride the loopback (@shigomori/contracts/link, LoopbackGroup).
// Effect RPC over a MessagePort the preload hands the window
// (main/preload.ts), served by main/ipc/shellLink.ts.
import { allContractModules } from "@shigomori/contracts/allModules";
import { callsOf } from "@shigomori/contracts/contract";
import { isHostSide } from "@shigomori/contracts/link";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { ClientTransport } from "@shared/ipc/transport";
import { openPortLink } from "@shared/remote/portLink";

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
  return openPortLink(
    {
      // A frame is a view into a buffer the encoder goes on writing,
      // which a port would clone whole: only its own bytes go.
      postMessage: (data) => port.postMessage(data.slice()),
      close: () => port.close(),
      listen: (onMessage, onClose) => {
        port.addEventListener("message", (event) => onMessage(event.data));
        port.addEventListener("close", onClose);
        port.start();
      },
    },
    ShellGroup,
  );
}
