import { windowContract } from "@shared/ipc/modules/window";
import type { Handlers } from "@shared/ipc/types";
import { applyThemeSource } from "../../electron/clientConfig";
import { relaunchApp } from "../../electron/relaunch";

export const windowHandlers: Handlers<typeof windowContract> = {
  // Track the renderer's applied theme (including unsaved previews) so
  // the vibrancy material follows the in-app appearance rather than
  // the OS one. Nothing is persisted here. The saved value lands
  // through the clientConfig module instead.
  previewTheme: ({ theme }) => {
    applyThemeSource(theme);
  },

  relaunch: () => {
    relaunchApp();
  },
};
