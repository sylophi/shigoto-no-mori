import { gitContract } from "@shigomori/contracts/modules/git";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import { BackgroundFetch } from "@host/lib/BackgroundFetch";
import { findProject } from "@host/lib/projects";
import type { HostServices } from "@host/process/services";

export const gitHandlers = {
  refreshProject: ({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      yield* (yield* BackgroundFetch).refreshProject(project.id, project.path);
    }),
  sweep: ({ renewal }) =>
    Effect.flatMap(BackgroundFetch, (fetch) => fetch.sweepForPeer(renewal)),
} satisfies EffectHandlers<typeof gitContract, unknown, HostServices>;
