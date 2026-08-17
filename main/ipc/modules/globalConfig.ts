import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import type { Handlers } from "@shared/ipc/types";
import { cliAvailable } from "../../electron/cliRunner";
import {
  invalidateGlobalConfigCache,
  readGlobalConfig,
  writeGlobalConfig,
} from "../../lib/config/global";
import { globalConfigWriteViaCli } from "../cliDelegate";

export const globalConfigHandlers: Handlers<typeof globalConfigContract> = {
  read: () => readGlobalConfig(),
  // Same engine rule as the worktree/project mutations: the CLI
  // performs the write when available. Windows stays on the TS path.
  write: async ({ config }) => {
    if (cliAvailable()) {
      await globalConfigWriteViaCli(config);
      // The watcher treats the delegated spawn as a self-write, so the
      // TTL cache must be dropped here rather than by the fs event.
      invalidateGlobalConfigCache();
      return;
    }
    await writeGlobalConfig(config);
  },
};
