// A contract handler written as an Effect. The registrar
// (registerContract.ts) awaits a Promise from every handler, so an
// Effect handler is adapted here: it runs with the caller's signal as
// the fiber's interruption, which means a departed caller (a page that
// navigated, a peer whose socket dropped, a CLI that was killed)
// cancels the work at its next step instead of letting it run to the
// end. Its failures are the typed errors the wires carry
// (shared/errors.ts); a defect rejects like any thrown bug did.
//
// `fromEffect` runs on Effect's default services (requirements are
// `never`); `fromEffectWith` runs on a runtime the caller names, read
// at call time, so a host handler's requirements are met by whatever
// the binding installed (host/runtime.ts).
import { Effect } from "effect";

export type HandlerRuntime<R> = {
  runPromise: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<A>;
};

export function fromEffectWith<I, O, R, Ctx extends { signal: AbortSignal }>(
  runtime: () => HandlerRuntime<R>,
  handle: (input: I, ctx: Ctx) => Effect.Effect<O, unknown, R>,
): (input: I, ctx: Ctx) => Promise<O> {
  return (input, ctx) => {
    // A caller already gone starts nothing: runPromise would evaluate
    // the effect's first step before honoring the signal.
    if (ctx.signal.aborted) {
      return Promise.reject(new Error("the caller is gone"));
    }
    return runtime().runPromise(handle(input, ctx), { signal: ctx.signal });
  };
}

const defaultRuntime: HandlerRuntime<never> = {
  runPromise: (effect, options) => Effect.runPromise(effect, options),
};

export function fromEffect<I, O, Ctx extends { signal: AbortSignal }>(
  handle: (input: I, ctx: Ctx) => Effect.Effect<O, unknown, never>,
): (input: I, ctx: Ctx) => Promise<O> {
  return fromEffectWith(() => defaultRuntime, handle);
}
