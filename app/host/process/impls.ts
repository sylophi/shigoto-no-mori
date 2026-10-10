// Wires the implementations the host-side handler modules take through
// a slot (host/lib/util/implSlot.ts), so each module stays a plain
// handler map. Must run before registerHostHandlers, so the first call
// never lands on a throwing default.
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { busyRemoteRefusal } from "@shared/busy";
import * as Effect from "effect/Effect";
import { setRuntimeImpl } from "@host/ipc/modules/runtime";
import { onGlobalConfigChange } from "@host/lib/config/global";
import { getBusyOperations } from "@host/lib/scripts";
import { onSharedSettingsChange } from "@host/lib/sharedSettings/store";
import * as Graph from "./graph";
import * as Loopback from "@host/socket/loopback";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import { shellCalls } from "./shell";
import { broadcastAll, refreshDirectHost } from "./wires";

export function installHostImpls(): void {
  // Reconcile the listener on every config change, whatever the path:
  // the write handler and a terminal write the store's changes show both
  // end in globalConfigChanged (host/lib/config/global.ts), which calls
  // this one subscriber, so the
  // directConnections opt-out applies without a restart. The refresh
  // never rejects, so fire and forget is safe. The start's pass is the
  // account's first report (handlers.ts applyAccount).
  onGlobalConfigChange(() => {
    void refreshDirectHost();
  });
  setRuntimeImpl({
    releaseStore: Effect.promise(() =>
      Graph.runIfUp(
        Effect.flatMap(StoreChanges.StoreChanges, (it) => it.release),
      ),
    ),
    stopUpdaterBridge: () => void shellCalls().stopUpdaterBridge(),
    unpublishLoopback: Effect.promise(() =>
      Graph.runIfUp(Effect.flatMap(Loopback.Loopback, (it) => it.unpublish)),
    ),
    broadcastNukeProgress: (progress) =>
      broadcastAll(runtimeContract, "nukeProgress", progress),
    afterDataWipe: () =>
      void Graph.runIfUp(Effect.flatMap(Loopback.Loopback, (it) => it.publish)),
    relaunchAppUnattended: () => void shellCalls().relaunch(),
    unattendedMoveRefusal: () => busyRemoteRefusal(getBusyOperations(), "move"),
  });
  // This device's copy of the shared settings moved (a pick here, or a
  // peer's entries merged in): every window re-reads it off the push,
  // and every peer's window folds it into its own copy.
  onSharedSettingsChange((doc) =>
    broadcastAll(sharedSettingsContract, "changed", doc),
  );
}
