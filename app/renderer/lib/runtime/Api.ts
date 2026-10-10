// window.api's contract half: one client per contract module over the
// link its scope rides, its calls, views and pushes run on the client's
// runtime, so they end with it.
import { isHostSide } from "@shigomori/contracts/link";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { buildApi, type RendererContractApi } from "@shared/ipc/client";
import { linkTransport } from "@shared/remote/rpcTransport";
import { ClientLinks } from "./ClientLinks";

export class Api extends Context.Service<Api, RendererContractApi>()(
  "sm/renderer/Api",
) {}

const make = Effect.gen(function* () {
  const links = yield* ClientLinks;
  const runFork = yield* FiberSet.makeRuntime<never>();
  const shell = linkTransport(links.shell, runFork);
  const host = linkTransport(links.host, runFork);
  return Api.of(buildApi((module) => (isHostSide(module) ? host : shell)));
});

export const layer = Layer.effect(Api, make);
