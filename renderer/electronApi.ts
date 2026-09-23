// Builds the desktop window's window.api from the preload's bridge:
// the argv facts plus buildApi over one transport that unwraps the
// Electron envelope into a real error on this side of contextBridge
// (see main/preload.ts for why the preload does not do this itself).
// Both scopes ride the same IPC bridge while host and client live in
// one process.
import { buildApi } from "@shared/ipc/client";
import type { ClientTransport } from "@shared/ipc/transport";
import { unwrapEnvelope } from "@shared/ipc/wireError";

export function installElectronApi(): void {
  const bridge = window.smBridge;
  const transport: ClientTransport = {
    invoke: (channel, input) =>
      bridge.invoke(channel, input).then(unwrapEnvelope),
    subscribe: (channel, handler) => bridge.subscribe(channel, handler),
  };
  window.api = {
    deviceId: bridge.deviceId,
    appVersion: bridge.appVersion,
    clerkPublishableKey: bridge.clerkPublishableKey,
    isDev: bridge.isDev,
    isElectron: true,
    ...buildApi({ host: transport, client: transport }),
  };
}
