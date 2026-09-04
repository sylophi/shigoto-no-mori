// Wires the Electron-side implementations into the host-scoped IPC
// handler modules, following the setMenuImpl / setUpdaterImpl
// precedent: handler modules stay free of Electron imports, and every
// Electron-backed capability they need arrives through a setter here.
// Must run before registerIpcHandlers so the first renderer call never
// lands on a throwing default.
import { shell } from "electron";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import { onGlobalConfigChange } from "@host/lib/config/global";
import { setCliImpl } from "@host/ipc/modules/cli";
import { setGitImpl } from "@host/ipc/modules/git";
import { setLaunchersImpl } from "@host/ipc/modules/launchers";
import { setRuntimeImpl } from "@host/ipc/modules/runtime";
import {
  broadcastAll,
  refreshDirectHost,
  refreshSocketHost,
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
import { maybeFetchProject } from "./fetch";
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
  setGitImpl({ maybeFetchProject });
  // Reconcile the socket listeners on every config change, whatever
  // the path: the IPC write handler, an external CLI write picked up
  // by the state watcher, and nuke wiping config.json all fan out
  // through invalidateGlobalConfigCache to this one subscriber. The
  // direct listener reconciles too so the directConnections opt-out
  // applies without a relaunch. Registered once here, and neither
  // refresh ever rejects, so fire and forget is safe. The boot-time
  // pass is main/index.ts's own refresh calls, since this fires only
  // on a subsequent change.
  onGlobalConfigChange(() => {
    void refreshSocketHost();
    void refreshDirectHost();
  });
  setLaunchersImpl({ openExternal: (url) => shell.openExternal(url) });
  setRuntimeImpl({
    uninstallCliEverything,
    stopStateWatcher,
    stopUpdaterBridge,
    broadcastNukeProgress: (progress) =>
      broadcastAll(runtimeContract, "nukeProgress", progress),
  });
  setCliRunnerImpl({ runCli, requireCliBinary, cliFailureMessage });
  installFileSyncSpawner();
}
