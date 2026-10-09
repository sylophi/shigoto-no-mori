// window.api on the desktop: the contract clients over two links. The
// shell's calls (dialogs, the window, the menu, the account) ride the
// port the preload hands over (shared/ipc/shell.ts), and the host's,
// every other, the loopback this machine's host serves its windows
// (shared/remote/hostLink.ts). A peer's host is reached through the hub bridge
// (shared/hub/bridgeHandlers.ts), never by swapping these.
import { isHostSide } from "@shigomori/contracts/link";
import { buildApi } from "@shared/ipc/client";
import { openShellLink, SHELL_PORT_CHANNEL } from "@shared/ipc/shell";
import { connectHost } from "@shared/remote/hostLink";

export async function installElectronApi(): Promise<void> {
  const bridge = window.electronBridge;
  if (bridge === undefined) throw new Error("the preload's bridge is missing");
  const { requestShellPort, ...facts } = bridge;
  const port = await new Promise<MessagePort>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const handed = event.ports[0];
      if (event.data !== SHELL_PORT_CHANNEL || handed === undefined) return;
      window.removeEventListener("message", onMessage);
      resolve(handed);
    };
    window.addEventListener("message", onMessage);
    requestShellPort();
  });
  const shell = { ...(await openShellLink(port)), local: true };
  type HostAddress = { port: number; token: string; deviceId: string };
  const address = () =>
    shell.invoke("window:hostAddress", undefined) as Promise<HostAddress>;
  // The device id is the host's, read from its store: in place before
  // any renderer module evaluates (index.tsx), since several read it at
  // module scope.
  const { deviceId } = await address();
  const host = connectHost({
    address,
    appVersion: facts.appVersion,
    openSocket: (url) => new WebSocket(url),
  });
  window.api = {
    ...facts,
    deviceId,
    ...buildApi((module) => (isHostSide(module) ? host : shell)),
  };
}
