import { app, ipcMain, nativeTheme } from "electron";
import { homedir } from "node:os";
import { CHANNELS } from "@shared/channels";
import { type RuntimeInfo, SetThemePayloadSchema } from "@shared/schemas";
import { nukeEverything } from "../electron/nuke";
import { shigomoriRoot } from "../lib/util/paths";

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

  // Track the renderer's applied theme (including unsaved previews) so
  // the vibrancy material follows the in-app appearance rather than the
  // OS one. The persistent value lives in ~/shigomori[-dev]/config.json
  // and is written by the renderer through the globalConfig IPC.
  ipcMain.handle(CHANNELS.RuntimeSetTheme, (_event, rawPayload: unknown) => {
    const { theme } = SetThemePayloadSchema.parse(rawPayload);
    nativeTheme.themeSource = theme;
  });
}
