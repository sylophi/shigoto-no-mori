// The host's git, which answers with effects, as Promises for a proof
// that drives it step by step: each call runs on one runtime of the
// engine's Git over the platform's own services, so its index locks and
// fetches are shared as in the app.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DataDirLock from "@shigomori/engine/DataDirLock";
import * as Git from "@shigomori/engine/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

// No data-folder move runs beside these proofs: the lock lets every
// change through.
const noMove = Layer.succeed(DataDirLock.DataDirLock, {
  held: Effect.void,
  guard: (effect) => effect,
  alone: (effect) => effect,
});

const runtime = ManagedRuntime.make(
  Layer.merge(Git.layer, noMove).pipe(Layer.provideMerge(NodeServices.layer)),
);

type Services = ManagedRuntime.ManagedRuntime.Services<typeof runtime>;

type Promised<M> = {
  [K in keyof M]: M[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer R, infer _E, Services>
    ? (...args: A) => Promise<R>
    : M[K];
};

// `relay` turns a failure into what the Promise rejects with.
export const promised = <M extends object>(
  module: M,
  relay: (error: unknown) => unknown = (error) => error,
): Promised<M> =>
  Object.fromEntries(
    Object.entries(module).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            const result: unknown = value(...args);
            return Effect.isEffect(result)
              ? runtime
                  .runPromise(
                    result as Effect.Effect<unknown, unknown, Services>,
                  )
                  .catch((error: unknown) => {
                    throw relay(error);
                  })
              : result;
          }
        : value,
    ]),
  ) as Promised<M>;

// The engine's Git itself, every call a Promise on the same runtime
// that rejects as the host relays a failure: a git that failed in git's
// own words, a refusal as itself.
export const engineGit = promised(runtime.runSync(Git.Git), (error) =>
  error instanceof Git.GitCommandError
    ? new Error(Git.stderrOf(error), { cause: error })
    : error,
);
