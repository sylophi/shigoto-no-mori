// Thin wrappers around Electron's shell API so the renderer can open files
// in the user's default app and reveal items in Finder.
import { shell } from "electron";
import { shellContract } from "@shared/ipc/modules/shell";
import type { Handlers } from "@shared/ipc/types";

export const shellHandlers: Handlers<typeof shellContract> = {
  openPath: async ({ path }) => {
    const message = await shell.openPath(path);
    if (message) throw new Error(message);
  },

  openExternal: async ({ url }) => {
    await shell.openExternal(url);
  },

  showItemInFolder: ({ path }) => {
    shell.showItemInFolder(path);
  },
};
