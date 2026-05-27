import { branchesContract } from "@shared/ipc/modules/branches/contract";
import type { Handlers } from "@shared/ipc/types";
import {
  createLocalBranch,
  deleteAnyLocalBranch,
  renameAnyLocalBranch,
} from "../../../lib/git";
import { findProjectOrThrow } from "../../../lib/projects";

export const branchesHandlers: Handlers<typeof branchesContract> = {
  create: async ({ projectId, name, base }) => {
    const project = findProjectOrThrow(projectId);
    await createLocalBranch(project.path, name, base);
  },

  rename: async ({ projectId, oldName, newName }) => {
    const project = findProjectOrThrow(projectId);
    await renameAnyLocalBranch(project.path, oldName, newName);
  },

  delete: async ({ projectId, name }) => {
    const project = findProjectOrThrow(projectId);
    await deleteAnyLocalBranch(project.path, name);
  },
};
