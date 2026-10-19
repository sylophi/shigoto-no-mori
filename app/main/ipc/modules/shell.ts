import { shell } from "electron";
import { shellContract } from "@shigomori/contracts/modules/shell";
import type { Handlers } from "@shigomori/contracts/types";

export const shellHandlers: Handlers<typeof shellContract> = {
  openExternal: async ({ url }) => {
    await shell.openExternal(url);
  },

  showItemInFolder: ({ path }) => {
    shell.showItemInFolder(path);
  },
};
