import { app, dialog } from "electron";
import { dialogContract } from "@shared/ipc/modules/dialog";
import type { Handlers } from "@shared/ipc/types";

export const dialogHandlers: Handlers<typeof dialogContract> = {
  pickFolder: async (opts) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: opts?.title ?? "Add a project",
      buttonLabel: opts?.buttonLabel ?? "Add project",
      message: opts?.message,
      // Electron 43 defaults pickers to ~/Downloads; home is the
      // sensible starting point for locating a project directory.
      defaultPath: app.getPath("home"),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  },
};
