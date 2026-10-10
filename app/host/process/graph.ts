// The root's one way into the layer graph: the services the listeners
// serve calls on, and the runs of the root's own callbacks (the hub
// connection's, the account fan-out's, the store watcher's). Its layer
// sits on top of the graph (host.ts), so it opens once every service
// is up: a call or a run before then waits for it, one after the graph
// failed is refused, and closing the graph turns new runs away and
// interrupts those still under way.
import { callFailureOf } from "@shigomori/contracts/errors";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Tunnel from "@host/direct/cloudflared";
import type * as MirrorDaemon from "@host/mirror/daemon";
import type * as Loopback from "@host/socket/loopback";
import type * as DeviceLink from "@host/socket/server";
import type { HostServices } from "./services";

// What the root's callbacks reach beyond what the handlers do.
export type GraphServices =
  | HostServices
  | DeviceLink.DeviceLink
  | Loopback.Loopback
  | Tunnel.Tunnel
  | MirrorDaemon.MirrorDaemon;

class GraphDownError extends Schema.TaggedError<GraphDownError>()(
  "GraphDownError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The app ${this.reason}.`;
  }
}

type RunPromise = <A, E>(
  effect: Effect.Effect<A, E, GraphServices>,
) => Promise<A>;

let ready = Deferred.makeUnsafe<
  { context: Context.Context<GraphServices>; run: RunPromise },
  GraphDownError
>();
let current: Context.Context<GraphServices> | undefined;

const settle = (
  exit: Exit.Exit<
    { context: Context.Context<GraphServices>; run: RunPromise },
    GraphDownError
  >,
) => {
  if (!Deferred.doneUnsafe(ready, exit)) {
    ready = Deferred.makeUnsafe();
    Deferred.doneUnsafe(ready, exit);
  }
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const context = yield* Effect.context<GraphServices>();
    const run: RunPromise = yield* FiberSet.makeRuntimePromise<GraphServices>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        current = undefined;
        settle(Exit.fail(new GraphDownError({ reason: "stopped" })));
      }),
    );
    current = context;
    settle(Exit.succeed({ context, run }));
  }),
);

// The graph failed to build: what waits on it is refused.
export const failed = (reason: string): void => {
  settle(
    Exit.fail(new GraphDownError({ reason: `failed to start: ${reason}` })),
  );
};

// The listeners' services (host/socket/server.ts LateServices).
export const services = Effect.suspend(() => Deferred.await(ready)).pipe(
  Effect.map((up) => up.context),
  Effect.mapError(callFailureOf),
);

// `effect` once the graph is up.
export const run = <A, E>(
  effect: Effect.Effect<A, E, GraphServices>,
): Promise<A> =>
  Effect.runPromise(Deferred.await(ready)).then((up) => up.run(effect));

// `effect` when the graph is up, else nothing.
export const runIfUp = (
  effect: Effect.Effect<void, never, GraphServices>,
): Promise<void> =>
  current === undefined
    ? Promise.resolve()
    : run(effect).catch(() => undefined);

// `effect` now, or `orElse` while the graph is not up.
export const readNow = <A>(
  effect: Effect.Effect<A, never, GraphServices>,
  orElse: () => A,
): A =>
  current === undefined ? orElse() : Effect.runSyncWith(current)(effect);
