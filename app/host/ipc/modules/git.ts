import { gitContract } from "@shigomori/contracts/modules/git";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import { BackgroundFetch } from "@host/lib/BackgroundFetch";
import { findProject } from "@host/lib/projects";
import type { HostServices } from "@host/process/services";

const refresh = (projectId: string) =>
  Effect.gen(function* () {
    const project = yield* findProject(projectId);
    yield* (yield* BackgroundFetch).refreshProject(project.id, project.path);
  });

export const gitHandlers = {
  refreshProject: ({ projectId }) => refresh(projectId),
  fetchProject: ({ projectId }) => refresh(projectId),
  sweep: ({ renewal }) =>
    Effect.flatMap(BackgroundFetch, (fetch) => fetch.sweepForPeer(renewal)),
} satisfies EffectHandlers<typeof gitContract, unknown, HostServices>;
