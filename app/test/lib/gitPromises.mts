// The host's git, which answers with effects, as Promises for a proof
// that drives it step by step: each call runs on one runtime of the
// engine's Git over the platform's own services, so its index locks and
// fetches are shared as in the app.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Git from "@shigomori/engine/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const runtime = ManagedRuntime.make(
  Git.layer.pipe(Layer.provideMerge(NodeServices.layer)),
);

type Services = ManagedRuntime.ManagedRuntime.Services<typeof runtime>;

type Promised<M> = {
  [K in keyof M]: M[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer R, infer _E, Services>
    ? (...args: A) => Promise<R>
    : M[K];
};

export const promised = <M extends object>(module: M): Promised<M> =>
  Object.fromEntries(
    Object.entries(module).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            const result: unknown = value(...args);
            return Effect.isEffect(result)
              ? runtime.runPromise(
                  result as Effect.Effect<unknown, unknown, Services>,
                )
              : result;
          }
        : value,
    ]),
  ) as Promised<M>;
