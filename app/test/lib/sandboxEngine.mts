// The engine a proof's sandbox brought up (smBinary.mts's hostEngine),
// which the host's handlers answer on in place of hostRuntime.mts's own:
// the sandbox's data dir is the one its terminal binary writes.
import type * as Context from "effect/Context";
import type * as Engine from "../../host/lib/Engine.ts";

let current: Context.Context<Engine.Services> | undefined;

export const setSandboxEngine = (
  context: Context.Context<Engine.Services> | undefined,
): void => {
  current = context;
};

export const sandboxEngine = (): Context.Context<Engine.Services> | undefined =>
  current;
