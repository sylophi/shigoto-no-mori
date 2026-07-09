// Thin wrappers around Electron's shell API so the renderer can open files
// in the user's default app and reveal items in the OS file manager.
// toNativePath: paths arrive in git's forward-slash form, which
// explorer.exe rejects.
import { shell } from "electron";
import { shellContract } from "@shared/ipc/modules/shell";
import type { Handlers } from "@shared/ipc/types";
import { toNativePath } from "../../lib/util/paths";

export const shellHandlers: Handlers<typeof shellContract> = {
  openPath: async ({ path }) => {
    const message = await shell.openPath(toNativePath(path));
    if (message) throw new Error(message);
  },

  openExternal: async ({ url }) => {
    await shell.openExternal(url);
  },

  showItemInFolder: ({ path }) => {
    shell.showItemInFolder(toNativePath(path));
  },
};
