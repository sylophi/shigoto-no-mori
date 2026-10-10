// The engine a proof's sandbox brought up (smBinary.mts's hostEngine),
// which the host's handlers answer on in place of adapters.mts's own:
// the sandbox's data dir is the one its terminal binary writes.
import type * as Context from "effect/Context";

let current: Context.Context<never> | undefined;

export const setSandboxEngine = (
  context: Context.Context<never> | undefined,
): void => {
  current = context;
};

export const sandboxEngine = (): Context.Context<never> | undefined => current;
