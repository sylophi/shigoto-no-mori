// Wires the Electron-side implementations into the host-scoped IPC
// handler modules, following the setMenuImpl / setUpdaterImpl
// precedent: handler modules stay free of Electron imports, and every
// Electron-backed capability they need arrives through a setter here.
// Must run before registerIpcHandlers so the first renderer call never
// lands on a throwing default.
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { sharedSettingsContract } from "@shared/ipc/modules/sharedSettings";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import { onGlobalConfigChange } from "@host/lib/config/global";
import { onSharedSettingsChange } from "@host/lib/sharedSettings/store";
import { setCliImpl } from "@host/ipc/modules/cli";
import { setGitImpl } from "@host/ipc/modules/git";
import { setRuntimeImpl } from "@host/ipc/modules/runtime";
import {
  broadcastAll,
  refreshDirectHost,
  republishControlHost,
  stopControlHost,
} from "../ipc/register";
import {
  cliLinkStatus,
  installCliLinks,
  uninstallCliEverything,
} from "./cliInstall";
import { cliFailureMessage, requireCliBinary, runCli } from "./cliRunner";
import { installFileSyncSpawner } from "./fileSyncRunner";
import {
  installShellIntegration,
  shellIntegrationStatus,
  uninstallShellIntegration,
} from "./cliShell";
import { busyActionRemoteRefusal } from "./busyPrompt";
import { refreshProject, sweepForPeer } from "./fetch";
import { relaunchAppUnattended } from "./relaunch";
import { stopStateWatcher } from "./stateWatcher";
import { stopUpdaterBridge } from "./updaterBridge";

export function installHostImpls(): void {
  setCliImpl({
    cliLinkStatus,
    installCliLinks,
    uninstallCliEverything,
    shellIntegrationStatus,
    installShellIntegration,
    uninstallShellIntegration,
  });
  setGitImpl({ refreshProject, sweepForPeer });
  // Reconcile the direct listener on every config change, whatever
  // the path: the IPC write handler, an external CLI write picked up
  // by the state watcher, and nuke wiping config.json all fan out
  // through invalidateGlobalConfigCache to this one subscriber, so the
  // directConnections opt-out applies without a relaunch. Registered
  // once here, and the refresh never rejects, so fire and forget is
  // safe. The boot-time pass rides main/index.ts's refreshHubConnection,
  // since this fires only on a subsequent change.
  onGlobalConfigChange(() => {
    void refreshDirectHost();
  });
  setRuntimeImpl({
    uninstallCliEverything,
    stopStateWatcher,
    stopUpdaterBridge,
    stopControlHost,
    broadcastNukeProgress: (progress) =>
      broadcastAll(runtimeContract, "nukeProgress", progress),
    afterDataWipe: republishControlHost,
    relaunchAppUnattended,
    unattendedMoveRefusal: () => busyActionRemoteRefusal("move"),
  });
  setCliRunnerImpl({ runCli, requireCliBinary, cliFailureMessage });
  // This device's copy of the shared settings moved (a pick here, or a
  // peer's entries merged in): every window re-reads it off the
  // broadcast, and every peer's window folds it into its own copy.
  onSharedSettingsChange((doc) =>
    broadcastAll(sharedSettingsContract, "changed", doc),
  );
  installFileSyncSpawner();
}
