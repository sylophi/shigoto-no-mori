import { buildClient } from "@shared/ipc/buildClient";
import {
  type ContractModule,
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
// wires one transport per scope: a desktop window its shell port and
// its loopback link, the web client its own registrar for both.
export type RendererContractApi = Api<AllContractModule>;

export function buildApi(
  transports:
    | Record<ContractScope, ClientTransport>
    | ((module: ContractModule) => ClientTransport),
): RendererContractApi {
  const transportOf =
    typeof transports === "function"
      ? transports
      : (module: ContractModule) => transports[scopeOf(module)];
  const api: Record<string, unknown> = {};
  for (const module of allContractModules) {
    const name = nameOf(module);
    if (name in api) throw new Error(`two contract modules are named ${name}`);
    api[name] = buildClient(module, transportOf(module));
  }
  return api as RendererContractApi;
}

// The host-scoped slice of the api: what a device serves, so window.api
// and a connected remote device's api both satisfy it.
export type HostApi = HostApiOf<AllContractModule>;
