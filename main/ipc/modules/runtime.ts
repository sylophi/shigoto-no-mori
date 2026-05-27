import { app, nativeTheme } from "electron";
import { homedir } from "node:os";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import type { Handlers } from "@shared/ipc/types";
import { nukeEverything } from "../../lib/nuke";
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

  nuke: () => nukeEverything(),
};
