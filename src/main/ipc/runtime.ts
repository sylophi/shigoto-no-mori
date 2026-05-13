import { app, ipcMain } from "electron";
import { homedir } from "node:os";
import { CHANNELS, type RuntimeInfo } from "@shared/channels";
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
}
