// The app's updater (shared/updater/machine.ts) in a host with no shell
// around it: the host is asked in this process, nobody is at it to
// confirm a busy restart (so it refuses as for another device), and the
// install puts the staged version in place here and quits, for the
// unit to start the new one.
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import * as Paths from "@shigomori/engine/Paths";
import * as Updater from "@shigomori/engine/Updater";
import * as Scripts from "@host/lib/Scripts";
import * as Graph from "@host/process/graph";
import { quit } from "@host/process/run";
import type { HostFacts } from "@shared/hostFacts";
import { bundledBinaryPath } from "@shared/packaging/bundledBinary.mts";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import { makeUpdater } from "@shared/updater/machine";

export const makeHeadlessUpdater = (
  facts: HostFacts,
  noteState: (state: UpdaterState) => void,
) => {
  const cliBinary = () =>
    bundledBinaryPath(facts, CLI_DIST_DIR, cliBinaryName(facts.flavor));
  const updater = makeUpdater({
    flavor: facts.flavor,
    packaged: facts.packaged,
    version: facts.appVersion,
    cliBinary,
    noteState,
    busy: () =>
      Graph.run(Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy)),
    confirmRestart: null,
    handOff: Effect.flatMap(Updater.Updater, (engine) =>
      engine.install({
        version: facts.appVersion,
        arch: process.arch,
        executable: cliBinary(),
        pid: process.pid,
      }),
    ),
    quit: () => quit(true),
  });
  return {
    ...updater,
    // Over the engine's updater, its paths and fetch.
    layer: updater.layer.pipe(
      Layer.provide(
        Updater.layer(facts.flavor).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Paths.layer(facts.flavor)),
        ),
      ),
    ),
  };
};
