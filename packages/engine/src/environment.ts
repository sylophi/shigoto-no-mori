// Reading the process's environment through Effect's Config.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// An environment variable, empty when unset.
export const envVar = (name: string) =>
  Config.String(name).pipe(Effect.orElseSucceed(() => ""));
