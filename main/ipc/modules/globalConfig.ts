import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import type { Handlers } from "@shared/ipc/types";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/global";

export const globalConfigHandlers: Handlers<typeof globalConfigContract> = {
  read: () => readGlobalConfig(),
  write: async ({ config }) => {
    await writeGlobalConfig(config);
  },
};
