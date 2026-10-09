// window.api on the desktop: the contract clients over two links. The
// shell's calls (dialogs, the window, the menu, the account) ride the
// port the preload hands over (shared/ipc/shell.ts), and the host's,
// every other, the loopback this machine's host serves its windows
// (hostLink.ts). A peer's host is reached through the hub bridge
// (shared/hub/bridgeHandlers.ts), never by swapping these.
import { isHostSide } from "@shigomori/contracts/link";
import { buildApi } from "@shared/ipc/client";
import { openShellLink, SHELL_PORT_CHANNEL } from "@shared/ipc/shell";
import { connectHost } from "./hostLink";

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
  const host = connectHost({
    shell,
    deviceId: facts.deviceId,
    appVersion: facts.appVersion,
  });
  window.api = {
    ...facts,
    ...buildApi((module) => (isHostSide(module) ? host : shell)),
  };
}
