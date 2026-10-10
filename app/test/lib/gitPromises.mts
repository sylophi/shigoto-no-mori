// The host's git, which answers with effects, as Promises for a proof
// that drives it step by step: each call runs on the platform's own
// services.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

type Promised<M> = {
  [K in keyof M]: M[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer R, infer _E, ChildProcessSpawner.ChildProcessSpawner>
    ? (...args: A) => Promise<R>
    : M[K];
};

const runGit = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, NodeServices.layer));

export const promised = <M extends object>(module: M): Promised<M> =>
  Object.fromEntries(
    Object.entries(module).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            const result: unknown = value(...args);
            return Effect.isEffect(result)
              ? runGit(
                  result as Effect.Effect<
                    unknown,
                    unknown,
                    ChildProcessSpawner.ChildProcessSpawner
                  >,
                )
              : result;
          }
        : value,
    ]),
  ) as Promised<M>;
