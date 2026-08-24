import { hygieneContract } from "@shared/ipc/modules/hygiene";
import type { Handlers } from "@shared/ipc/types";
import { findProjectOrThrow } from "@host/lib/projects";
import {
  collectProjectHygiene,
  findWorktreeForDisk,
  measureWorktreeDisk,
} from "@host/lib/worktrees/hygiene";

export const hygieneHandlers: Handlers<typeof hygieneContract> = {
  list: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return collectProjectHygiene(project.id, project.path);
  },

  diskUsage: async ({ projectId, worktreeId }) => {
    const project = findProjectOrThrow(projectId);
    const worktree = await findWorktreeForDisk(
      project.id,
      project.path,
      worktreeId,
    );
    return measureWorktreeDisk(project.id, project.path, worktree);
  },
};
