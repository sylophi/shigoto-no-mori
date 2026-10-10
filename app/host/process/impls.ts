// Wires the implementations the host-side handler modules take through
// a slot (host/lib/util/implSlot.ts), so each module stays a plain
// handler map. Must run before registerHostHandlers, so the first call
// never lands on a throwing default.
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { busyRemoteRefusal } from "@shared/busy";
import { setCliImpl } from "@host/ipc/modules/cli";
import { setGitImpl } from "@host/ipc/modules/git";
import { setRuntimeImpl } from "@host/ipc/modules/runtime";
import { requireCliBinary } from "@host/lib/cli/binary";
import { cliLinkStatus, installCliLinks } from "@host/lib/cli/install";
import { hookPathEnv } from "@host/lib/cli/shell";
import { onGlobalConfigChange } from "@host/lib/config/global";
import { refreshProject, sweepForPeer } from "@host/lib/git/backgroundFetch";
import { getBusyOperations } from "@host/lib/scripts";
import { onSharedSettingsChange } from "@host/lib/sharedSettings/store";
import { publishLoopback, releaseStore, unpublishLoopback } from "./captures";
import { hostFacts } from "./facts";
import { shellCalls } from "./shell";
import { broadcastAll, refreshDirectHost } from "./wires";

export function installHostImpls(): void {
  setCliImpl({
    cliLinkStatus,
    installCliLinks,
    hookPathEnv,
    appVersion: () => hostFacts().appVersion,
    binaryPath: requireCliBinary,
  });
  setGitImpl({ refreshProject, sweepForPeer });
  // Reconcile the listener on every config change, whatever the path:
  // the write handler, an external CLI write picked up by the store
  // watcher, and nuke wiping config.json all fan out through
  // invalidateGlobalConfigCache to this one subscriber, so the
  // directConnections opt-out applies without a restart. The refresh
  // never rejects, so fire and forget is safe. The start's pass is the
  // account's first report (handlers.ts applyAccount).
  onGlobalConfigChange(() => {
    void refreshDirectHost();
  });
  setRuntimeImpl({
    releaseStore,
    stopUpdaterBridge: () => void shellCalls().stopUpdaterBridge(),
    unpublishLoopback,
    broadcastNukeProgress: (progress) =>
      broadcastAll(runtimeContract, "nukeProgress", progress),
    afterDataWipe: () => void publishLoopback(),
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
