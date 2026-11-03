// The shell's session with its host (packages/contracts/src/modules/
// session.ts), on the loopback alone.
import { sessionContract } from "@shigomori/contracts/modules/session";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Scripts from "@host/lib/Scripts";
import * as Graph from "./graph";
import * as BackgroundFetch from "@host/lib/BackgroundFetch";
import * as Tunnel from "@host/direct/Tunnel";
import * as Agents from "@shigomori/engine/Agents";
import { dirname } from "node:path";
import * as HostFacts from "@host/lib/HostFacts";
import * as HostRpc from "@host/socket/hostRpc";
import { applyAccount, noteAccountDevices } from "./handlers";
import * as Shell from "@host/lib/Shell";
import * as WtFolder from "@shigomori/engine/WtFolder";
import { asCall, changing } from "@host/lib/Engine";
import { probeRemoteConnections } from "./wires";

// The root's own Promise work, for the session's calls.
const onRoot = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

export const sessionHandlers = (options: {
  // The shell asked the host to stop. `hurried` is an update install or
  // a relaunch, which signals scripts instead of waiting them out.
  readonly quit: (hurried: boolean) => void;
}) =>
  HostRpc.handlers(sessionContract, {
    account: (facts) => onRoot(() => applyAccount(facts)),
    accountDevices: (deviceIds) =>
      Effect.sync(() => noteAccountDevices(deviceIds)),
    // One sent before the graph is up lands once it is.
    windowFocused: (focused) =>
      Effect.sync(
        () =>
          void Graph.run(
            Effect.map(BackgroundFetch.BackgroundFetch, (fetch) =>
              fetch.setWindowFocused(focused),
            ),
          ).catch(() => {}),
      ),
    // A wake, or the network changing: the remote links probe now, and
    // the tunnel checks it is still reachable.
    wake: () =>
      Effect.sync(() => {
        probeRemoteConnections();
        void Graph.run(
          Effect.flatMap(Tunnel.Tunnel, (tunnel) => tunnel.recheck),
        ).catch(() => {});
      }),
    busy: () => Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy),
    updaterState: (state) =>
      Effect.flatMap(Shell.Shell, (shell) => shell.updater.noteState(state)),
    // The user's agent on a guide session the shell minted for one of its
    // windows. Like a resume, it writes no state. A release's agent reads
    // the source at its tag, a dev build's the checkout it runs from.
    guideLaunch: (input) =>
      Effect.flatMap(HostFacts.HostFacts, (facts) =>
        Effect.flatMap(Agents.Agents, (agents) =>
          agents.guide({
            ...input,
            source: facts.packaged
              ? { tag: `v${facts.appVersion}` }
              : { checkout: dirname(facts.appPath) },
          }),
        ).pipe(
          Effect.mapError(callFailureOf),
          Effect.catchDefect((defect) => Effect.fail(callFailureOf(defect))),
        ),
      ),
    // Counted as a change, so a quit or an update waits for its move.
    migrationRetry: () =>
      onRoot(() =>
        Graph.run(
          asCall(
            changing(
              Effect.flatMap(WtFolder.WtFolder, (folder) => folder.retryStuck),
              {},
              "move",
            ),
          ),
        ),
      ),
    quit: ({ hurried }) => Effect.sync(() => options.quit(hurried)),
  });
