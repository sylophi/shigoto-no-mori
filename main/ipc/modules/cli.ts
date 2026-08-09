import { cliContract } from "@shared/ipc/modules/cli";
import type { Handlers } from "@shared/ipc/types";
import {
  installCliLinks,
  cliLinkStatus,
  uninstallCliLinks,
} from "../../electron/cliInstall";

export const cliHandlers: Handlers<typeof cliContract> = {
  status: () => cliLinkStatus(),
  install: () => installCliLinks(),
  // uninstallCliLinks only ever removes a link we own, so a foreign
  // occupant survives this unchanged and the returned status says so.
  uninstall: async () => {
    await uninstallCliLinks();
    return cliLinkStatus();
  },
};
