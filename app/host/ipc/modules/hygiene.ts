import { hygieneContract } from "@shigomori/contracts/modules/hygiene";
import type { Handlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/engine";
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
} satisfies Handlers<typeof hygieneContract, unknown, Engine.Services>;
