import { menuContract } from "@shigomori/contracts/modules/menu";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import type { LaunchToolMenuEntry } from "@shigomori/contracts/schemas";

// The electron layer injects the actual menu-rebuild function at boot.
// Keeps the handler module free of Electron imports while still letting
// the renderer drive native menu state.
type SetLaunchToolsEnabledFn = (
  windowId: number,
  enabled: boolean,
  entries?: readonly LaunchToolMenuEntry[],
) => void;

let impl: SetLaunchToolsEnabledFn = () => {
  throw new Error("menu handler invoked before electron registered impl");
};

export function setMenuImpl(fn: SetLaunchToolsEnabledFn): void {
  impl = fn;
}

export const menuHandlers: Handlers<typeof menuContract, HandlerContext> = {
  // The calling window's tools: only a window calls, on its own port.
  setLaunchToolsEnabled: ({ enabled, entries }, { windowId }) => {
    if (windowId !== undefined) impl(windowId, enabled, entries);
  },
};
