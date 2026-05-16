import { app, ipcMain } from "electron";
import { homedir } from "node:os";
import { CHANNELS } from "@shared/channels";
import type { RuntimeInfo } from "@shared/schemas";
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
