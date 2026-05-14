import { app, ipcMain } from "electron";
import { homedir } from "node:os";
import { CHANNELS, type RuntimeInfo } from "@shared/channels";
import { nukeEverything } from "../nuke";
import { shigomoriRoot } from "../paths";

export function registerRuntimeHandlers(): void {
  ipcMain.handle(
    CHANNELS.RuntimeInfo,
    (): RuntimeInfo => ({
      shigomoriRoot: shigomoriRoot(),
      homedir: homedir(),
      isDev: !app.isPackaged,
    }),
  );

  ipcMain.handle(CHANNELS.RuntimeNuke, () => nukeEverything());
}
