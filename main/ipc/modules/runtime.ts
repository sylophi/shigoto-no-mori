import { app, nativeTheme } from "electron";
import { homedir } from "node:os";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import type { Handlers } from "@shared/ipc/types";
import { setDoubutsu } from "../../electron/appearance";
import { ensureShigomoriRoot } from "../../electron/bootstrap";
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

  // Same contract for doubutsu: native chrome (the win32 caption
  // overlay and window background) follows the applied value.
  setDoubutsu: ({ enabled }) => {
    setDoubutsu(enabled);
  },

  // Reseed the empty root before resolving (bootstrap otherwise only
  // runs at app launch): post-nuke renderer refetches read a fresh
  // valid layout, and a stray state write can't resurrect a half-empty
  // root that launch-time bootstrap never gets to repair.
  nuke: async () => {
    await nukeEverything();
    await ensureShigomoriRoot();
  },
};
