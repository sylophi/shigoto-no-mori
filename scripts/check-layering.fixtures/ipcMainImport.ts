// Fixture: a named `ipcMain` import. In fixtures the layer is forced to
// "lib" so this fires `lib-electron-runtime` (a stricter rule than the
// `electron-ipc-import` rule applied to the electron layer).
import { ipcMain } from "electron";

export const x = ipcMain;
