import type { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import type { EffectHandlers } from "@shigomori/contracts/types";
import type * as DeviceId from "@host/lib/config/DeviceId";
import type * as Engine from "@host/lib/Engine";
import { findProject } from "@host/lib/projects";
import * as EngineConfig from "@shigomori/engine/Config";
import * as Effect from "effect/Effect";
import { switchSync } from "@host/lib/sharedSettings/projectSettings";

export const shigomoriHandlers = {
  // The project's settings as stored. An unknown project id answers
  // with the entity-gone error.
  read: ({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      return yield* (yield* EngineConfig.Config).readProject(
        EngineConfig.projectScope(project),
      );
    }),
  // The engine's patch, which also handles the in-project exclude side
  // effect and refuses an unknown project the same way.
  patch: ({ projectId, patch }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      yield* (yield* EngineConfig.Config).patchProject(
        EngineConfig.projectScope(project),
        patch,
      );
    }),
  syncSettings: ({ projectId, on }) => switchSync(projectId, on),
} satisfies EffectHandlers<
  typeof shigomoriContract,
  unknown,
  Engine.Services | DeviceId.DeviceId
>;
