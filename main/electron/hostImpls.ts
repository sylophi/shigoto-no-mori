// Wires the Electron-side implementations into the host-scoped IPC
// handler modules, following the setMenuImpl / setUpdaterImpl
// precedent: handler modules stay free of Electron imports, and every
// Electron-backed capability they need arrives through a setter here.
// Must run before registerIpcHandlers so the first renderer call never
// lands on a throwing default.
import { shell } from "electron";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { setCliRunnerImpl } from "../ipc/cliDelegate";
import { setCliImpl } from "../ipc/modules/cli";
import { setGitImpl } from "../ipc/modules/git";
import { setLaunchersImpl } from "../ipc/modules/launchers";
import { setRuntimeImpl } from "../ipc/modules/runtime";
import { broadcastAll } from "../ipc/register";
import {
  cliLinkStatus,
  installCliLinks,
  uninstallCliEverything,
} from "./cliInstall";
import { cliFailureMessage, requireCliBinary, runCli } from "./cliRunner";
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
  setLaunchersImpl({ openExternal: (url) => shell.openExternal(url) });
  setRuntimeImpl({
    uninstallCliEverything,
    stopStateWatcher,
    stopUpdaterBridge,
    broadcastNukeProgress: (progress) =>
      broadcastAll(runtimeContract, "nukeProgress", progress),
  });
  setCliRunnerImpl({ runCli, requireCliBinary, cliFailureMessage });
}
