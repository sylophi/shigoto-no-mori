// Thin wrappers around Electron's shell API so the renderer can open files
// in the user's default app and reveal items in the OS file manager.
import { ipcMain, shell } from "electron";
import { CHANNELS } from "@shared/channels";
import { ShellPathPayloadSchema } from "@shared/schemas";

export function registerShellHandlers(): void {
  ipcMain.handle(
    CHANNELS.ShellOpenPath,
    async (_event, rawPayload: unknown) => {
      const { path } = ShellPathPayloadSchema.parse(rawPayload);
      const message = await shell.openPath(path);
      if (message) throw new Error(message);
    },
  );

  ipcMain.handle(
    CHANNELS.ShellShowItemInFolder,
    (_event, rawPayload: unknown) => {
      const { path } = ShellPathPayloadSchema.parse(rawPayload);
      shell.showItemInFolder(path);
    },
  );
}
