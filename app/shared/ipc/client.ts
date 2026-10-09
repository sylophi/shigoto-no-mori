import { buildClient } from "@shared/ipc/buildClient";
import {
  type ContractScope,
  nameOf,
  scopeOf,
} from "@shigomori/contracts/contract";
import type {
  Api,
  ChannelHandlers,
  HostApiOf,
} from "@shigomori/contracts/types";
import type { ClientTransport } from "@shared/ipc/transport";
import {
  type AllContractModule,
  allContractModules,
} from "@shigomori/contracts/allModules";

// A table answering any channel of any module above, typed by the
// contracts: the fake host's fixture handlers.
export type AllChannelHandlers = Partial<ChannelHandlers<AllContractModule>>;

// The api: one namespace per module above, named for it, each the
// module's client on the transport its scope is wired to. The caller
// wires one transport per scope: the Electron preload's bridge carries
// both (host and client live in one process there), the web client
// passes its loopback wires.
export type RendererContractApi = Api<AllContractModule>;

export function buildApi(
  transports: Record<ContractScope, ClientTransport>,
): RendererContractApi {
  const api: Record<string, unknown> = {};
  for (const module of allContractModules) {
    const name = nameOf(module);
    if (name in api) throw new Error(`two contract modules are named ${name}`);
    api[name] = buildClient(module, transports[scopeOf(module)]);
  }
  return api as RendererContractApi;
}

// The host-scoped slice of the api: what a device serves, so window.api
// and a connected remote device's api both satisfy it.
export type HostApi = HostApiOf<AllContractModule>;
