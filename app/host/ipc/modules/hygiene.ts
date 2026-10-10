import { hygieneContract } from "@shigomori/contracts/modules/hygiene";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Effect from "effect/Effect";
import type { HostServices } from "@host/process/services";
import { findProject } from "@host/lib/projects";
import {
  collectProjectHygiene,
  findWorktreeForDisk,
  measureWorktreeDisk,
} from "@host/lib/worktrees/hygiene";

export const hygieneHandlers = {
  list: ({ projectId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      collectProjectHygiene(project.id, project.path),
    ),

  diskUsage: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const worktree = yield* findWorktreeForDisk(project.id, worktreeId);
      return yield* measureWorktreeDisk(project.id, worktree);
    }),
} satisfies EffectHandlers<typeof hygieneContract, unknown, HostServices>;
