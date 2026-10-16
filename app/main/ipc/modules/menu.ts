import { menuContract } from "@shigomori/contracts/modules/menu";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import type { LaunchToolMenuEntry } from "@shigomori/contracts/schemas";
import type { GuideHarness } from "@shigomori/contracts/modules/guide";

// The electron layer injects the actual menu-rebuild function at boot.
// Keeps the handler module free of Electron imports while still letting
// the renderer drive native menu state.
type MenuImpl = {
  readonly setLaunchToolsEnabled: (
    windowId: number,
    enabled: boolean,
    entries?: readonly LaunchToolMenuEntry[],
  ) => void;
  readonly setChords: (
    windowId: number,
    chords: Readonly<Record<string, string>>,
  ) => void;
  readonly setGuideHarnesses: (
    windowId: number,
    harnesses: readonly GuideHarness[],
  ) => void;
  readonly showAround: (
    windowId: number,
    at: { readonly x: number; readonly y: number },
  ) => void;
};

const unset = () => {
  throw new Error("menu handler invoked before electron registered impl");
};
let impl: MenuImpl = {
  setLaunchToolsEnabled: unset,
  setChords: unset,
  setGuideHarnesses: unset,
  showAround: unset,
};

export function setMenuImpl(next: MenuImpl): void {
  impl = next;
}

export const menuHandlers: Handlers<typeof menuContract, HandlerContext> = {
  // The calling window's tools: only a window calls, on its own port.
  setLaunchToolsEnabled: ({ enabled, entries }, { windowId }) => {
    if (windowId !== undefined) {
      impl.setLaunchToolsEnabled(windowId, enabled, entries);
    }
  },
  // The calling window's keys for the menu's actions (its keymap).
  setChords: ({ chords }, { windowId }) => {
    if (windowId !== undefined) impl.setChords(windowId, chords);
  },
  // The guide's harnesses installed on the calling window's device.
  setGuideHarnesses: (harnesses, { windowId }) => {
    if (windowId !== undefined) impl.setGuideHarnesses(windowId, harnesses);
  },
  showAround: (at, { windowId }) => {
    if (windowId !== undefined) impl.showAround(windowId, at);
  },
};
