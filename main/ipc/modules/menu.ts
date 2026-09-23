import { Context } from "effect";
import { menuContract } from "@shared/ipc/modules/menu";
import type { Handlers } from "@shared/ipc/types";
import type { LaunchToolMenuEntry } from "@shared/schemas";
import { hostService } from "@host/runtime";

// The electron layer provides the actual menu-rebuild function. Keeps
// the handler module free of Electron imports while still letting the
// renderer drive native menu state.
type SetLaunchToolsEnabledFn = (
  enabled: boolean,
  entries?: readonly LaunchToolMenuEntry[],
) => void;

export class Menu extends Context.Service<Menu, SetLaunchToolsEnabledFn>()(
  "sm/main/Menu",
) {}

export const menuHandlers: Handlers<typeof menuContract> = {
  setLaunchToolsEnabled: ({ enabled, entries }) => {
    hostService(Menu, "menu handler invoked before the runtime provided Menu")(
      enabled,
      entries,
    );
  },
};
