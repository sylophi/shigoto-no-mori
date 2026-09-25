import { menuContract } from "@shared/ipc/modules/menu";
import type { Handlers } from "@shared/ipc/types";
import type { LaunchToolMenuEntry } from "@shared/schemas";

// The electron layer injects the actual menu-rebuild function at boot.
// Keeps the handler module free of Electron imports while still letting
// the renderer drive native menu state.
type SetLaunchToolsEnabledFn = (
  enabled: boolean,
  entries?: LaunchToolMenuEntry[],
) => void;

let impl: SetLaunchToolsEnabledFn = () => {
  throw new Error("menu handler invoked before electron registered impl");
};

export function setMenuImpl(fn: SetLaunchToolsEnabledFn): void {
  impl = fn;
}

export const menuHandlers: Handlers<typeof menuContract> = {
  setLaunchToolsEnabled: ({ enabled, entries }) => {
    impl(enabled, entries);
  },
};
