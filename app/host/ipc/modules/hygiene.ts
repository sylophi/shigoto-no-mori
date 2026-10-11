import { hygieneContract } from "@shigomori/contracts/modules/hygiene";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Effect from "effect/Effect";
import type { HostServices } from "@host/process/services";
import { findProject } from "@host/lib/projects";
import * as Worktrees from "@host/lib/Worktrees";

export const hygieneHandlers = {
  list: ({ projectId }) =>
    Effect.flatMap(
      Effect.all([findProject(projectId), Worktrees.Worktrees]),
      ([project, worktrees]) => worktrees.hygiene(project.id, project.path),
    ),

  diskUsage: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* findProject(projectId);
      const worktree = yield* worktrees.worktreeForDisk(project.id, worktreeId);
      return yield* worktrees.diskUsage(project.id, worktree);
    }),
} satisfies EffectHandlers<typeof hygieneContract, unknown, HostServices>;
