import { windowContract } from "@shigomori/contracts/modules/window";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { applyThemeSource } from "../../electron/clientConfig";
import { showNotification } from "../../electron/notifications";
import { relaunchApp } from "../../electron/relaunch";
import { noteShowing, openWindow } from "../../electron/windows";
import { hostAddress } from "../../hostProcess";

export const windowHandlers: Handlers<typeof windowContract, HandlerContext> = {
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
  hostAddress: () => hostAddress(),

  open: ({ route }) => {
    openWindow(route);
  },

  showing: ({ route }, { windowId }) => {
    noteShowing(windowId, route);
  },
};
