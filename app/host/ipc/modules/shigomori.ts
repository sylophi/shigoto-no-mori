import type { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import type { EffectHandlers } from "@shigomori/contracts/types";
import type * as Engine from "@host/lib/Engine";
import * as Ops from "@host/lib/engineOps";
import { switchSync } from "@host/lib/sharedSettings/projectSettings";

export const shigomoriHandlers = {
  // The project's settings as stored. An unknown project id answers
  // with the entity-gone error.
  read: ({ projectId }) => Ops.readProjectConfig(projectId),
  // The engine's patch, which also handles the in-project exclude side
  // effect and refuses an unknown project the same way.
  patch: ({ projectId, patch }) => Ops.patchProjectConfig(projectId, patch),
  syncSettings: ({ projectId, on }) => switchSync(projectId, on),
} satisfies EffectHandlers<typeof shigomoriContract, unknown, Engine.Services>;
