import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import type { Handlers } from "@shared/ipc/types";
import {
  invalidateGlobalConfigCache,
  readGlobalConfig,
  redactGlobalConfigForRead,
} from "@host/lib/config/global";
import { globalConfigWriteViaCli } from "../cliDelegate";

export const globalConfigHandlers: Handlers<typeof globalConfigContract> = {
  // Redact before returning: socketHost.token is a secret and must be
  // absent from the read on either wire. Redaction happens here (not
  // only in the output schema) because packaged builds skip output
  // re-parsing.
  read: async () => redactGlobalConfigForRead(await readGlobalConfig()),
  // Same engine rule as the worktree/project mutations: the CLI
  // performs the write.
  write: async ({ config }) => {
    await globalConfigWriteViaCli(config);
    // The watcher treats the delegated spawn as a self-write, so the
    // TTL cache must be dropped here rather than by the fs event. This
    // fans out to the config-change subscribers too, so the socket
    // listener reconciles with the just-written document. No separate
    // refresh hook is needed: every config-change path reconciles
    // through invalidateGlobalConfigCache now.
    invalidateGlobalConfigCache();
  },
};
