import { sgmCliContract } from "@shared/ipc/modules/sgmCli";
import type { Handlers } from "@shared/ipc/types";
import {
  installSgmCliLink,
  sgmCliStatus,
  uninstallSgmCliLink,
} from "../../electron/sgmCli";

export const sgmCliHandlers: Handlers<typeof sgmCliContract> = {
  status: () => sgmCliStatus(),
  install: () => installSgmCliLink(),
  // uninstallSgmCliLink only ever removes a link we own, so a foreign
  // occupant survives this unchanged and the returned status says so.
  uninstall: async () => {
    await uninstallSgmCliLink();
    return sgmCliStatus();
  },
};
