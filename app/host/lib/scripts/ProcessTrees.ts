// Ending the process trees the host started: the scripts (./ScriptRuns.ts),
// the terminals and the lifecycle scripts the engine runs. Each OS ends
// them its own way (processTrees/).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { byPlatform } from "@shigomori/engine/platform";
import { makeSignals } from "./processTrees/signals";

export class ProcessTrees extends Context.Service<
  ProcessTrees,
  {
    // Asks the tree under `pid` to end: a stop, or a hangup, which an
    // interactive shell (ignoring a stop) ends on. `ownGroup`: a PTY run's
    // shell leads a group, and a lifecycle script runs in the host's.
    readonly ask: (
      tree: { readonly pid: number; readonly ownGroup: boolean },
      how: "stop" | "hangup",
    ) => Effect.Effect<void>;
    // A stop to a PTY run's tree without reading the process table: the
    // update-install quit can't wait on that.
    readonly askNow: (pid: number) => Effect.Effect<void>;
    // Ends the tree, whether or not it listens.
    readonly end: (tree: {
      readonly pid: number;
      readonly ownGroup: boolean;
    }) => Effect.Effect<void>;
  }
>()("sm/host/ProcessTrees") {}

const make = Effect.gen(function* () {
  return ProcessTrees.of(
    yield* byPlatform({ darwin: makeSignals, linux: makeSignals }),
  );
});

export const layer = Layer.effect(ProcessTrees, make);
