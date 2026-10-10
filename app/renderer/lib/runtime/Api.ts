// window.api's contract half: one client per contract module over the
// link its scope rides, and a peer's (peerApi) over the hub hop, their
// calls, views and pushes run on the client's runtime, so they end
// with it.
import { type ContractModule, scopeOf } from "@shigomori/contracts/contract";
import { hubContract } from "@shigomori/contracts/modules/hub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { buildApi, type RendererContractApi } from "@shared/ipc/client";
import type { ClientTransport, Link } from "@shared/ipc/transport";
import { linkTransport } from "@shared/remote/rpcTransport";
import { ClientLinks } from "./ClientLinks";
import { peerLink } from "./peerLink";

export type ClientApi = RendererContractApi & {
  // A peer's api, its host modules over the hub hop. A client module
  // belongs to the machine the window runs on, so a peer's rejects.
  readonly peerApi: (deviceId: string) => RendererContractApi;
};

export class Api extends Context.Service<Api, ClientApi>()("sm/renderer/Api") {}

const CLIENT_SCOPE_REFUSAL =
  "client-scoped call is not available for a remote device";

const refusingClientScope: ClientTransport = {
  invoke: () => Promise.reject(new Error(CLIENT_SCOPE_REFUSAL)),
  subscribe() {
    console.warn(`[remote] ${CLIENT_SCOPE_REFUSAL}`);
    return () => {};
  },
};

const make = Effect.gen(function* () {
  const { linkOf } = yield* ClientLinks;
  const runFork = yield* FiberSet.makeRuntime<never>();
  const transports = new Map<Link, ClientTransport>();
  const transportOf = (module: ContractModule) => {
    const link = linkOf(module);
    let transport = transports.get(link);
    if (transport === undefined) {
      transport = linkTransport(link, runFork);
      transports.set(link, transport);
    }
    return transport;
  };
  // The side that holds the peers' sessions, which the hop rides.
  const hub = linkOf(hubContract);
  return Api.of({
    ...buildApi(transportOf),
    peerApi: (deviceId) => {
      const peer = linkTransport(peerLink(hub, deviceId), runFork);
      return buildApi((module) =>
        scopeOf(module) === "host" ? peer : refusingClientScope,
      );
    },
  });
});

export const layer = Layer.effect(Api, make);
