import { app, nativeTheme } from "electron";
import { homedir } from "node:os";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import type { Handlers } from "@shared/ipc/types";
import { setDoubutsu } from "../../electron/appearance";
import { uninstallCliEverything } from "../../electron/cliInstall";
import { nukeEverything } from "../../lib/nuke";
import { broadcastAll } from "../register";
import { shigomoriRoot } from "../../lib/util/paths";

export const runtimeHandlers: Handlers<typeof runtimeContract> = {
  info: () => ({
    shigomoriRoot: shigomoriRoot(),
    homedir: homedir(),
    isDev: !app.isPackaged,
  }),

  // Track the renderer's applied theme (including unsaved previews) so
  // the vibrancy material follows the in-app appearance rather than the
  // OS one. The persistent value lives in ~/shigomori[-dev]/config.json
  // and is written by the renderer through the globalConfig IPC.
  setTheme: ({ theme }) => {
    nativeTheme.themeSource = theme;
  },

  // Same contract for doubutsu: native chrome (the win32 caption
  // overlay and window background) follows the applied value.
  setDoubutsu: ({ enabled }) => {
    setDoubutsu(enabled);
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
