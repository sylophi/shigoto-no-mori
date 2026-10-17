// The page api's contract half (pageApi.tsx): one effect client per
// contract module over the link its scope rides, and a peer's (peerApi)
// over the hub hop. A call is an effect, a push and a view are streams,
// and each api runs them on the client's runtime (`run`, `listen`), so
// they end with it.
import { allContractModules } from "@shigomori/contracts/allModules";
import type { AllContractModule } from "@shigomori/contracts/allModules";
import {
  callOf,
  type ContractModule,
  nameOf,
  scopeOf,
} from "@shigomori/contracts/contract";
import {
  CommandRefusedError,
  isCommandRefusedError,
} from "@shigomori/contracts/errors";
import { hubContract } from "@shigomori/contracts/modules/hub";
import type {
  EffectApi,
  HostModulesOf,
  PushKeys,
  PushPayload,
  ViewInput,
  ViewKeys,
  ViewValue,
} from "@shigomori/contracts/types";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { effectClient } from "@shared/ipc/effectClient";
import type { Link } from "@shared/ipc/transport";
import { pushesOn, viewOn } from "./atoms";
import { ClientLinks } from "./ClientLinks";
import { peerLink } from "./peerLink";

type HostModule = HostModulesOf<AllContractModule>;

// What every api runs its effects with: the client's runtime.
type Runner = {
  // A call (or any effect over them) as a Promise: its answer, or the
  // error it failed with as it is (the contract error's class, a
  // RemoteCallError with the far side's message). `signal` interrupts
  // it, which cancels the call on the far side: a query hands React
  // Query's, so a fetch it supersedes or drops stops the host's work.
  readonly run: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<A>;
  // A stream's values as they come, until the returned stop. `onEnd`
  // hears it end on its own, with the failure when it failed. A value
  // that throws is logged, and the next still lands.
  readonly listen: <A, E>(
    stream: Stream.Stream<A, E>,
    onValue: (value: A) => void,
    onEnd?: (failure?: unknown) => void,
  ) => () => void;
};

// A push or a view of a module the api reaches, by the call's name.
type Streams<M extends ContractModule> = {
  readonly pushes: <N extends M, K extends PushKeys<N>>(
    module: N,
    key: K,
  ) => Stream.Stream<PushPayload<N, K>>;
  readonly view: <N extends M, K extends ViewKeys<N>>(
    module: N,
    key: K,
    input: ViewInput<N, K>,
  ) => Stream.Stream<ViewValue<N, K>, unknown>;
};

// A device's api: its host modules, which the page's api and a peer's
// both serve.
export type HostApi = EffectApi<HostModule> & Streams<HostModule> & Runner;

export type ClientApi = EffectApi<AllContractModule> &
  Streams<AllContractModule> &
  Runner & {
    // A peer's api, its host modules over the hub hop. A client module
    // belongs to the machine the window runs on, so a peer's has none.
    readonly peerApi: (deviceId: string) => HostApi;
  };

export class Api extends Context.Service<Api, ClientApi>()("sm/renderer/Api") {}

function clientsOf(
  modules: readonly ContractModule[],
  linkOf: (module: ContractModule) => Link,
): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  for (const module of modules) {
    const name = nameOf(module);
    if (name in api) throw new Error(`two contract modules are named ${name}`);
    api[name] = effectClient(module, linkOf(module));
  }
  return api;
}

function streamsOf(linkOf: (module: ContractModule) => Link) {
  return {
    pushes: (module: ContractModule, key: string) =>
      pushesOn(linkOf(module), callOf(module, key)),
    view: (module: ContractModule, key: string, input: unknown) =>
      viewOn(linkOf(module), callOf(module, key), input),
  };
}

const hostModules = allContractModules.filter(
  (module) => scopeOf(module) === "host",
);

const make = Effect.gen(function* () {
  const { linkOf } = yield* ClientLinks;
  const run = yield* FiberSet.makeRuntimePromise<never>();
  const runFork = yield* FiberSet.makeRuntime<never>();
  const runner: Runner = {
    run,
    listen: (stream, onValue, onEnd) => {
      let stopped = false;
      const fiber = runFork(
        Stream.runForEach(stream, (value) =>
          Effect.sync(() => onValue(value)).pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("a stream's reader threw", defect),
            ),
          ),
        ).pipe(
          Effect.exit,
          Effect.map((exit) => {
            // Stopped here, or the runtime going, is no end to hear.
            if (stopped || onEnd === undefined) return;
            if (Exit.isSuccess(exit)) onEnd();
            else if (!Cause.hasInterruptsOnly(exit.cause)) {
              onEnd(Cause.squash(exit.cause));
            }
          }),
        ),
      );
      return () => {
        stopped = true;
        runFork(Fiber.interrupt(fiber));
      };
    },
  };
  // The side that holds the peers' sessions, which the hop rides.
  const hub = linkOf(hubContract);
  return Api.of({
    ...(clientsOf(allContractModules, linkOf) as EffectApi<AllContractModule>),
    ...(streamsOf(linkOf) as Streams<AllContractModule>),
    ...runner,
    peerApi: (deviceId) => {
      const peer = peerLink(hub, deviceId);
      return {
        ...(clientsOf(hostModules, () => peer) as EffectApi<HostModule>),
        ...(streamsOf(() => peer) as Streams<HostModule>),
        ...runner,
        run: (effect, options) =>
          run(
            Effect.mapError(effect, (error) =>
              isCommandRefusedError(error)
                ? new CommandRefusedError({ deviceId })
                : error,
            ),
            options,
          ),
      };
    },
  });
});

export const layer = Layer.effect(Api, make);
