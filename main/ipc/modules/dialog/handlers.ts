import { dialog } from "electron";
import { dialogContract } from "@shared/ipc/modules/dialog/contract";
import type { Handlers } from "@shared/ipc/types";

export const dialogHandlers: Handlers<typeof dialogContract> = {
  pickFolder: async (opts) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: opts?.title ?? "Add a project",
      buttonLabel: opts?.buttonLabel ?? "Add project",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  },
};
