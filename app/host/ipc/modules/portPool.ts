import { portPoolContract } from "@shared/ipc/modules/portPool";
import type { Handlers } from "@shared/ipc/types";
import { findWorktreeIdentityOrThrow } from "@host/lib/git/worktrees";
import {
  isPortPoolActive,
  isPortPoolEnabled,
  isPortPoolInstalled,
} from "@host/lib/portPool";
import { findProjectOrThrow } from "@host/lib/projects";

export const portPoolHandlers: Handlers<typeof portPoolContract> = {
  isActive: async ({ projectId, worktreeId }) => {
    // The toggle first, before anything forks git: off is the default,
    // and a stale worktree id must answer false, not throw.
    if (!(await isPortPoolEnabled())) return false;
    const project = findProjectOrThrow(projectId);
    const worktree = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    return isPortPoolActive(worktree.path);
  },

  isInstalled: () => isPortPoolInstalled(),
};
