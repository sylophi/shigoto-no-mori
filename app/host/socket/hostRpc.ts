// A host module's handlers as the layer the device link and the loopback
// serve it from (DeviceLink.ts): each call run on the host's graph as it
// is when the call comes, failing as the contract error it is or as
// RemoteCallError (hostCallFailure). Which calls a peer reaches is the
// link's group's to say, and its gates' (link.ts).
import {
  annotation,
  Busy,
  type ContractCall,
  type ContractModule,
  callsOf,
  channelOf,
  isInvoke,
  isPush,
  keyOf,
  TracksProjectUsage,
} from "@shigomori/contracts/contract";
import type { CallFailure } from "@shigomori/contracts/errors";
import { GRANTS } from "@shigomori/contracts/grants";
import { LinkPeer } from "@shigomori/contracts/link";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import type { EffectHandlers, ViewHandlers } from "@shigomori/contracts/types";
import { storeErrorOf } from "@shigomori/engine/storeErrors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";
import type { HandlerContext } from "@shared/ipc/transport";
import { changing, hostCallFailure } from "@host/lib/Engine";
import * as HostPushes from "@host/lib/HostPushes";
import { recordProjectActionUsage } from "@host/lib/projects/usage";
import type { HostServices } from "@host/process/services";
import { boundedMessages } from "./boundedMessages";

// The graph's services, once the root has them: a call or a view that
// comes first waits for them, and is refused if the graph failed.
export class HostGraph extends Context.Service<
  HostGraph,
  Effect.Effect<Context.Context<HostServices>, CallFailure>
>()("sm/host/HostGraph") {}

// The calls that change code (a peer needs the grant for them), which
// run only while no data-folder move can start.
const changesCode: ReadonlySet<string> = new Set(GRANTS.changeCode.calls);

// The caller as a handler reads it, until the handlers read LinkPeer.
const contextOf = (peer: LinkPeer["Service"]): HandlerContext => ({
  connection: peer.closed,
  callerDeviceId: peer.deviceId,
  channels: peer.channels,
  notifier: (module, key) => (push) => peer.notify(module, key, push),
});

// The sidebar's usage sorts rank the payload's project, and reorder
// live on the push.
const bumpUsage = (payload: unknown) =>
  Effect.flatMap(recordProjectActionUsage(payload), (projectId) =>
    projectId === null
      ? Effect.void
      : HostPushes.push(projectsContract, "usageBumped", { projectId }),
  );

// What a module's handlers are to a listener: the handlers of its
// group's calls, read off the graph per call.
export type HandlerLayer = Layer.Layer<Rpc.Handler<string>, never, HostGraph>;

type Invoke = (
  input: unknown,
  ctx: HandlerContext,
) => Effect.Effect<unknown, unknown, HostServices>;
type View = (input: unknown) => Stream.Stream<unknown, unknown, HostServices>;

// A module's invokes and its views, served wherever a listener's group
// carries their calls.
export const handlers = <M extends ContractModule>(
  module: M,
  invokes: NoInfer<EffectHandlers<M, HandlerContext, HostServices>>,
  views?: NoInfer<ViewHandlers<M, HostServices>>,
): HandlerLayer => {
  // Typed per call above, read here by key: the group's decode of each
  // payload is the check.
  const byKey = { ...invokes, ...views } as Record<string, Invoke | View>;
  const served = callsOf(module).filter(
    (call) => !isPush(call) && byKey[keyOf(call)] !== undefined,
  );
  return RpcGroup.make(...served).toLayer(
    Effect.gen(function* () {
      const graph = yield* HostGraph;
      const scope = yield* Effect.scope;

      const invoke = (call: ContractCall, fn: Invoke) => {
        const channel = channelOf(call);
        const tracked = annotation(call, TracksProjectUsage) === true;
        return (payload: unknown) =>
          Effect.gen(function* () {
            const ctx = contextOf(yield* LinkPeer);
            const services = yield* graph;
            const run = Effect.flatten(
              Effect.try({
                try: () => fn(payload, ctx),
                catch: hostCallFailure,
              }),
            );
            return yield* (
              changesCode.has(channel)
                ? changing(run, {}, annotation(call, Busy))
                : run
            ).pipe(
              Effect.tap(() =>
                tracked
                  ? Effect.forkIn(bumpUsage(payload), scope)
                  : Effect.void,
              ),
              // The engine reads the store as a given, so a write the
              // store refuses (a data-folder move holding it still, a
              // full disk) ends the call as a defect, which crosses in
              // the store's words.
              Effect.catchDefect((defect) =>
                storeErrorOf(defect) === undefined
                  ? Effect.die(defect)
                  : Effect.fail(defect),
              ),
              Effect.provideContext(services),
            );
          }).pipe(
            Effect.mapError(hostCallFailure),
            Effect.annotateSpans({ channel }),
          );
      };

      const view = (fn: View) => (payload: unknown) =>
        Stream.unwrap(
          Effect.map(graph, (services) =>
            fn(payload).pipe(Stream.provideContext(services)),
          ),
        ).pipe(Stream.mapError(hostCallFailure), boundedMessages);

      return Object.fromEntries(
        served.map((call) => {
          const fn = byKey[keyOf(call)];
          return [
            channelOf(call),
            isInvoke(call) ? invoke(call, fn as Invoke) : view(fn as View),
          ];
        }),
      ) as never;
    }),
  ) as HandlerLayer;
};
