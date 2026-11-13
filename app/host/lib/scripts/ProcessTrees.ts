// Ending the process trees the host started: the scripts (./ScriptRuns.ts),
// the terminals and the lifecycle scripts the engine runs. Each OS ends
// them its own way (processTrees/).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { byPlatform } from "@shigomori/engine/platform";
import { makeConsoles } from "./processTrees/consoles";
import { makeSignals } from "./processTrees/signals";

type Tree = {
  readonly pid: number;
  // A PTY run's shell leads a group, and a lifecycle script runs in the
  // host's.
  readonly ownGroup: boolean;
  // Closes the PTY a run's tree is attached to, while the host holds
  // it: the hangup where no signal is one.
  readonly closeTerminal?: () => void;
};

export class ProcessTrees extends Context.Service<
  ProcessTrees,
  {
    // Asks the tree under `pid` to end: a stop, or a hangup, which an
    // interactive shell (ignoring a stop) ends on.
    readonly ask: (tree: Tree, how: "stop" | "hangup") => Effect.Effect<void>;
    // A stop to a PTY run's tree without reading the process table: the
    // update-install quit can't wait on that.
    readonly askNow: (tree: Tree) => Effect.Effect<void>;
    // Ends the tree, whether or not it listens.
    readonly end: (tree: Tree) => Effect.Effect<void>;
  }
>()("sm/host/ProcessTrees") {}

// `nativefs` is the helper that reads and ends trees on Windows.
const make = (nativefs: string) =>
  Effect.gen(function* () {
    return ProcessTrees.of(
      yield* byPlatform({
        darwin: makeSignals,
        linux: makeSignals,
        win32: makeConsoles(nativefs),
      }),
    );
  });

export const layer = (nativefs: string) =>
  Layer.effect(ProcessTrees, make(nativefs));
