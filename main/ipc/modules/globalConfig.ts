import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import type { Handlers } from "@shared/ipc/types";
import {
  invalidateGlobalConfigCache,
  readGlobalConfig,
} from "../../lib/config/global";
import { invalidateTerrierCaches } from "../../lib/terrier";
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
    // The terrier merge gates on the toggle just written; without this
    // the sidebar would keep the pre-save project list for a TTL.
    invalidateTerrierCaches();
  },
};
