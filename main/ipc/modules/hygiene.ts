import { hygieneContract } from "@shared/ipc/modules/hygiene";
import type { Handlers } from "@shared/ipc/types";
import { findProjectOrThrow } from "../../lib/projects";
import { findWorktreeIdentityOrThrow } from "../../lib/git/worktrees";
import {
  collectProjectHygiene,
  measureWorktreeDisk,
} from "../../lib/worktrees/hygiene";

export const hygieneHandlers: Handlers<typeof hygieneContract> = {
  list: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return collectProjectHygiene(project.id, project.path);
  },

  diskUsage: async ({ projectId, worktreeId }) => {
    const project = findProjectOrThrow(projectId);
    const worktree = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    return measureWorktreeDisk(worktree.id, worktree.path);
  },
};
