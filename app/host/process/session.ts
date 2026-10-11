// Wires the host up as it starts, ahead of its graph: the handlers on
// its wires, and the shell's session
// (packages/contracts/src/modules/session.ts) on the loopback.
import { sessionContract } from "@shigomori/contracts/modules/session";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { HandlerContext } from "@shared/ipc/transport";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import { getBusyOperations } from "@host/lib/scripts";
import * as Graph from "./graph";
import type { HostServices } from "./services";
import * as Terminals from "@host/lib/terminals/Terminals";
import * as BackgroundFetch from "@host/lib/git/backgroundFetch";
import {
  applyAccount,
  noteAccountDevices,
  registerHostHandlers,
} from "./handlers";
import * as Shell from "@host/lib/Shell";
import {
  broadcastAll,
  probeRemoteConnections,
  registerLoopbackContract,
} from "./wires";

// What a quit asks about: the terminals busy right now.
const busyTerminals = () =>
  Graph.run(Effect.flatMap(Terminals.Terminals, (it) => it.busy)).catch(
    () => 0,
  );

// The root's own Promise work, for the session's calls.
const onRoot = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

export function startHost(options: {
  // The shell asked the host to stop. `hurried` is an update install or
  // a relaunch, which signals scripts instead of waiting them out.
  readonly quit: (hurried: boolean) => void;
}): void {
  registerHostHandlers();
  const session: EffectHandlers<
    typeof sessionContract,
    HandlerContext,
    HostServices
  > = {
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
    wake: () => Effect.sync(probeRemoteConnections),
    busy: () =>
      Effect.map(onRoot(busyTerminals), (terminals) => ({
        ...getBusyOperations(),
        busyTerminals: terminals,
      })),
    updaterState: (state) =>
      Effect.flatMap(Shell.Shell, (shell) =>
        shell.updater.noteState(state),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => broadcastAll(updaterContract, "state", state)),
        ),
      ),
    quit: ({ hurried }) => Effect.sync(() => options.quit(hurried)),
  };
  registerLoopbackContract(sessionContract, session);
}
