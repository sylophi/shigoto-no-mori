// Ending the process trees the host started: the scripts (./ScriptRuns.ts),
// the terminals and the lifecycle scripts the engine runs. Each OS ends
// them its own way (processTrees/).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { byFamily } from "@shigomori/engine/platform";
import { makeConsoles } from "./processTrees/consoles";
import { makeSignals } from "./processTrees/signals";
import type { Stop, Tree } from "./processTrees/tree";

export { exitedWithin } from "./processTrees/tree";

export class ProcessTrees extends Context.Service<
  ProcessTrees,
  {
    // Asks the tree under `pid` to end, ends it if it is still there
    // past the grace, and waits for it to go: true once it has. One
    // that outlives its end is logged and given up on.
    readonly stop: (tree: Tree, stop: Stop) => Effect.Effect<boolean>;
    // Asks the tree to end without waiting for it to go: the
    // update-install quit can't.
    readonly stopNow: (tree: Tree) => Effect.Effect<void>;
    // Lets go of a PTY run's tree once its shell has exited on its own.
    readonly release: (tree: Tree) => Effect.Effect<void>;
  }
>()("sm/host/ProcessTrees") {}

// `nativefs` is the helper that reads and ends trees on Windows.
const make = (nativefs: string) =>
  Effect.gen(function* () {
    return ProcessTrees.of(
      yield* byFamily({
        posix: makeSignals,
        windows: makeConsoles(nativefs),
      }),
    );
  });

export const layer = (nativefs: string) =>
  Layer.effect(ProcessTrees, make(nativefs));
