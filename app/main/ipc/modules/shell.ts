// Thin wrappers around Electron's shell API so the renderer can open links
// in the user's browser and reveal items in Finder.
import { shell } from "electron";
import { shellContract } from "@shared/ipc/modules/shell";
import type { Handlers } from "@shared/ipc/types";

export const shellHandlers: Handlers<typeof shellContract> = {
  openExternal: async ({ url }) => {
    await shell.openExternal(url);
  },

  showItemInFolder: ({ path }) => {
    shell.showItemInFolder(path);
  },
};
