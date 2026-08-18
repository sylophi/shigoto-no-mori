import { app, nativeTheme } from "electron";
import { homedir } from "node:os";
import { basename } from "node:path";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import type { Handlers } from "@shared/ipc/types";
import { uninstallCliEverything } from "../../electron/cliInstall";
import { logFilePath } from "../../electron/log";
import { relaunchApp } from "../../electron/relaunch";
import { stopStateWatcher } from "../../electron/stateWatcher";
import { stopUpdaterBridge } from "../../electron/updaterBridge";
import { nukeEverything } from "../../lib/nuke";
import { moveShigomoriRoot } from "../../lib/rootMove";
import { broadcastAll } from "../register";
import { shigomoriRoot } from "../../lib/util/paths";

export const runtimeHandlers: Handlers<typeof runtimeContract> = {
  info: () => ({
    shigomoriRoot: shigomoriRoot(),
    rootDirName: basename(shigomoriRoot()),
    homedir: homedir(),
    logFile: logFilePath(),
    isDev: !app.isPackaged,
  }),

  // Track the renderer's applied theme (including unsaved previews) so
  // the vibrancy material follows the in-app appearance rather than the
  // OS one. The persistent value lives in ~/shigomori[-dev]/config.json
  // and is written by the renderer through the globalConfig IPC.
  setTheme: ({ theme }) => {
    nativeTheme.themeSource = theme;
  },

  moveRoot: async ({ parentDir }) => {
    await moveShigomoriRoot(parentDir, {
      beforeMove: () => {
        stopStateWatcher();
        stopUpdaterBridge();
      },
    });
    // The root is a boot-time constant (initShigomoriRoot's one-shot
    // guard exists precisely so it can't change under live callers).
    // The renderer calls `relaunch` once this reply lands.
  },

  relaunch: () => {
    relaunchApp();
  },

  nuke: async () => {
    await nukeEverything((progress) =>
      broadcastAll(runtimeContract, "nukeProgress", progress),
    );
    // Nuke means "remove everything shigomori put on this machine";
    // the CLI links and the shell-integration hooks are part of that.
    // Settings offers a fresh install afterwards.
    await uninstallCliEverything();
  },
};
