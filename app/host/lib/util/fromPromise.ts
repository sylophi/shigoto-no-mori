// A Promise function of the host's not converted yet, called from an
// effect: its rejection fails the effect as it crosses a wire
// (callFailureOf), an interruption aborts its signal, and the spans it
// makes (and the calls it makes on a peer) continue the effect's trace.
// Scaffolding for V3.md's host Promise adapters, gone with the last
// Promise caller.
import { type CallFailure, callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import { withParentSpan } from "./trace";

export const fromPromise = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, CallFailure> =>
  Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
    Effect.tryPromise({
      try: (signal) => withParentSpan(span, () => run(signal)),
      catch: callFailureOf,
    }),
  );
