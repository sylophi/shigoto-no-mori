import { cliContract } from "@shared/ipc/modules/cli";
import type { Handlers } from "@shared/ipc/types";
import {
  installCliLinks,
  cliLinkStatus,
  uninstallCliEverything,
} from "../../electron/cliInstall";
import {
  installShellIntegration,
  shellIntegrationStatus,
  uninstallShellIntegration,
} from "../../electron/cliShell";

export const cliHandlers: Handlers<typeof cliContract> = {
  status: () => cliLinkStatus(),
  install: ({ force }) => installCliLinks(force),
  // Only ever removes what shigomori made (links it owns, hooks it
  // wrote), so a foreign occupant survives this unchanged and the
  // returned status says so.
  uninstall: async () => {
    await uninstallCliEverything();
    return cliLinkStatus();
  },
  shellStatus: () => shellIntegrationStatus(),
  shellInstall: () => installShellIntegration(),
  shellUninstall: () => uninstallShellIntegration(),
};
