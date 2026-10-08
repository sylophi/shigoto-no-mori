// window.api on the desktop: the contract clients over the preload's
// bridge (main/preload.ts). Host and client scopes ride the same IPC
// wire, since both live in one process here. A peer's host is reached
// through the hub bridge (shared/hub/bridgeHandlers.ts), never by
// swapping this wire. Built in the renderer so a handler's contract
// error, which crosses the bridge as data, becomes its class here.
import { buildApi } from "@shared/ipc/client";
import { type ClientTransport, unsettle } from "@shared/ipc/transport";

export function installElectronApi(): void {
  const bridge = window.electronBridge;
  if (bridge === undefined) throw new Error("the preload's bridge is missing");
  const { invoke, subscribe, ...facts } = bridge;
  const transport: ClientTransport = {
    local: true,
    invoke: async (channel, input) => unsettle(await invoke(channel, input)),
    subscribe,
  };
  window.api = {
    ...facts,
    ...buildApi({ host: transport, client: transport }),
  };
}
