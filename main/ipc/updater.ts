import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import type { UpdaterState } from "@shared/schemas";
import {
  checkForUpdates,
  getUpdaterState,
  installUpdate,
} from "../electron/updater";

export function registerUpdaterHandlers(): void {
  ipcMain.handle(CHANNELS.UpdaterGet, (): UpdaterState => getUpdaterState());
  ipcMain.handle(CHANNELS.UpdaterCheck, () => checkForUpdates());
  ipcMain.handle(CHANNELS.UpdaterInstall, () => installUpdate());
}
