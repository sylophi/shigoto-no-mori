import { homedir } from "node:os";
import { basename } from "node:path";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import type { Handlers } from "@shared/ipc/types";
import { uninstallCliEverything } from "../../electron/cliInstall";
import { stopStateWatcher } from "../../electron/stateWatcher";
import { stopUpdaterBridge } from "../../electron/updaterBridge";
import { nukeEverything } from "@host/lib/nuke";
import { moveShigomoriRoot } from "@host/lib/rootMove";
import { broadcastAll } from "../register";
import { shigomoriRoot } from "@host/lib/util/paths";

export const runtimeHandlers: Handlers<typeof runtimeContract> = {
  // Host facts only. isDev deliberately isn't here: it describes the
  // client build and rides the preload bridge (api.isDev) instead.
  info: () => ({
    shigomoriRoot: shigomoriRoot(),
    rootDirName: basename(shigomoriRoot()),
    homedir: homedir(),
  }),

  moveRoot: async ({ parentDir }) => {
    await moveShigomoriRoot(parentDir, {
      beforeMove: () => {
        stopStateWatcher();
        stopUpdaterBridge();
      },
    });
    // The root is a boot-time constant (initShigomoriRoot's one-shot
    // guard exists precisely so it can't change under live callers).
    // The renderer calls the window module's `relaunch` once this
    // reply lands.
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
