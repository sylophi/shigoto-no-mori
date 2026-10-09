import { windowContract } from "@shigomori/contracts/modules/window";
import type { Handlers } from "@shigomori/contracts/types";
import { applyThemeSource } from "../../electron/clientConfig";
import { showNotification } from "../../electron/notifications";
import { relaunchApp } from "../../electron/relaunch";
import { host } from "../../hostProcess";

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

  notify: (input) => {
    showNotification(input);
  },

  // Where the window reaches its host, asked again on every redial
  // (renderer/hostLink.ts), so a host that came back elsewhere is found.
  hostAddress: () => host().address(),
};
