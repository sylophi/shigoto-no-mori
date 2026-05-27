import { dialog, ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import { PickFolderPayloadSchema } from "@shared/schemas";

export function registerDialogHandlers(): void {
  ipcMain.handle(
    CHANNELS.DialogPickFolder,
    async (_event, rawPayload: unknown) => {
      const opts = PickFolderPayloadSchema.parse(rawPayload);
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: opts?.title ?? "Add a project",
        buttonLabel: opts?.buttonLabel ?? "Add project",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
  );
}
