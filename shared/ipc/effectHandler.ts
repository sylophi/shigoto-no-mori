// A contract handler written as an Effect. The registrar
// (registerContract.ts) awaits a Promise from every handler, so an
// Effect handler is adapted here: it runs with the caller's signal as
// the fiber's interruption, which means a departed caller (a page that
// navigated, a peer whose socket dropped, a CLI that was killed)
// cancels the work at its next step instead of letting it run to the
// end. Its failures are the typed errors the wires carry
// (shared/errors.ts); a defect rejects like any thrown bug did.
//
// Requirements are `never` on purpose: until the host has a runtime
// of its own (EFFECT-MIGRATION.md, Phase 2 step 7), a handler's
// dependencies arrive the way they do today, and the Effect form buys
// interruption, typed failures and timeouts.
import { Effect } from "effect";

export function fromEffect<I, O, Ctx extends { signal: AbortSignal }>(
  handle: (input: I, ctx: Ctx) => Effect.Effect<O, unknown, never>,
): (input: I, ctx: Ctx) => Promise<O> {
  return (input, ctx) => {
    // A caller already gone starts nothing: runPromise would evaluate
    // the effect's first step before honoring the signal.
    if (ctx.signal.aborted) {
      return Promise.reject(new Error("the caller is gone"));
    }
    return Effect.runPromise(handle(input, ctx), { signal: ctx.signal });
  };
}
