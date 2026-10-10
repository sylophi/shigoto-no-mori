import type { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";

export const shigomoriHandlers = {
  // The project's settings as stored. An unknown project id answers
  // with the entity-gone error.
  read: ({ projectId }) => Ops.readProjectConfig(projectId),
  // The engine's write, which also handles the in-project exclude side
  // effect and refuses an unknown project the same way.
  write: ({ projectId, config }) => Ops.writeProjectConfig(projectId, config),
} satisfies EffectHandlers<typeof shigomoriContract, unknown, Engine.Services>;
