// A Promise function of the host's not converted yet, called from an
// effect: its rejection fails the effect as it crosses a wire
// (callFailureOf), and an interruption aborts its signal. Scaffolding
// for V3.md's host Promise adapters, gone with the last Promise caller.
import { type CallFailure, callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";

export const fromPromise = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, CallFailure> =>
  Effect.tryPromise({ try: run, catch: callFailureOf });
