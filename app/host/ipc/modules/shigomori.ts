import type { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import type { Handlers } from "@shigomori/contracts/types";
import {
  invalidateProjectConfigCache,
  readShigomoriConfig,
} from "@host/lib/config/project";
import { shigomoriWriteViaCli } from "../cliDelegate";

export const shigomoriHandlers: Handlers<typeof shigomoriContract> = {
  // project.json as stored, read through the CLI (`sm projects config
  // read`), which answers an unknown project id with the entity-gone
  // error. Cached for a few seconds (host/lib/config/project.ts).
  read: ({ projectId }) => readShigomoriConfig(projectId),

  write: async ({ projectId, config }) => {
    // Same engine rule as the other mutations: the CLI performs the
    // write (it also handles the in-project exclude side effect and
    // validates projectId, mapping onto the same unknown-project
    // error).
    await shigomoriWriteViaCli(projectId, config);
    // The watcher treats the delegated spawn as a self-write, so the
    // TTL cache must be dropped here rather than by the fs event.
    invalidateProjectConfigCache(projectId);
  },
};
