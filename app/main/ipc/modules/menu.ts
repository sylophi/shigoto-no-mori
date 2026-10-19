import type { menuContract } from "@shigomori/contracts/modules/menu";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import {
  setChords,
  setGuideHarnesses,
  setLaunchToolsEnabled,
} from "../../electron/menu";

export const menuHandlers: Handlers<typeof menuContract, HandlerContext> = {
  // The calling window's tools: only a window calls, on its own port.
  setLaunchToolsEnabled: ({ enabled, entries }, { windowId }) => {
    if (windowId !== undefined) {
      setLaunchToolsEnabled(windowId, enabled, entries);
    }
  },
  // The calling window's keys for the menu's actions (its keymap).
  setChords: ({ chords }, { windowId }) => {
    if (windowId !== undefined) setChords(windowId, chords);
  },
  // The guide's harnesses installed on the calling window's device.
  setGuideHarnesses: (harnesses, { windowId }) => {
    if (windowId !== undefined) setGuideHarnesses(windowId, harnesses);
  },
};
