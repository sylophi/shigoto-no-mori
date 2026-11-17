import { app, dialog } from "electron";
import { dialogContract } from "@shigomori/contracts/modules/dialog";
import type { Handlers } from "@shigomori/contracts/types";
import { canonicalPath } from "@shigomori/engine/canonicalPath";

export const dialogHandlers: Handlers<typeof dialogContract> = {
  pickFolder: async (opts) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: opts?.title ?? "Add a project",
      buttonLabel: opts?.buttonLabel ?? "Add project",
      message: opts?.message,
      // Electron 43 defaults pickers to ~/Downloads. Home is the
      // sensible starting point when the caller has no better one.
      defaultPath: opts?.defaultPath ?? app.getPath("home"),
    });
    const picked = result.canceled ? undefined : result.filePaths[0];
    return picked === undefined ? null : canonicalPath(picked);
  },
};
