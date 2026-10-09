import type { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import type { Handlers } from "@shigomori/contracts/types";
import { readShigomoriConfig } from "@host/lib/config/project";
import { writeProjectConfig } from "@host/lib/engineCalls";

export const shigomoriHandlers: Handlers<typeof shigomoriContract> = {
  // The project's settings as stored. An unknown project id answers
  // with the entity-gone error.
  read: ({ projectId }) => readShigomoriConfig(projectId),
  // The engine's write, which also handles the in-project exclude side
  // effect and refuses an unknown project the same way.
  write: ({ projectId, config }) => writeProjectConfig(projectId, config),
};
