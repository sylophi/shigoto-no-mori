import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import type { Handlers } from "@shared/ipc/types";
import {
  invalidateGlobalConfigCache,
  readGlobalConfig,
} from "../../lib/config/global";
import { globalConfigWriteViaCli } from "../cliDelegate";

export const globalConfigHandlers: Handlers<typeof globalConfigContract> = {
  read: () => readGlobalConfig(),
  // Same engine rule as the worktree/project mutations: the CLI
  // performs the write.
  write: async ({ config }) => {
    await globalConfigWriteViaCli(config);
    // The watcher treats the delegated spawn as a self-write, so the
    // TTL cache must be dropped here rather than by the fs event.
    invalidateGlobalConfigCache();
  },
};
