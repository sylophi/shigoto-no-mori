// The engine a proof's sandbox brought up (smBinary.mts's hostEngine),
// which the host's handlers answer on in place of adapters.mts's own:
// the sandbox's data dir is the one its terminal binary writes.
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Engine from "../../host/lib/engine.ts";

let current: Context.Context<Engine.Services> | undefined;

export const setSandboxEngine = (
  context: Context.Context<Engine.Services> | undefined,
): void => {
  current = context;
};

export const sandboxEngine = (): Context.Context<Engine.Services> | undefined =>
  current;

// An engine effect run on it, for a proof that reads or writes through
// the engine the way the host does.
export const onSandboxEngine = <A, E>(
  effect: Effect.Effect<A, E, Engine.Services>,
): Promise<A> => {
  if (current === undefined) {
    return Promise.reject(new Error("No sandbox engine is up."));
  }
  return Effect.runPromiseWith(current)(effect);
};
