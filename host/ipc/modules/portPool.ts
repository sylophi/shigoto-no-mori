import { portPoolContract } from "@shared/ipc/modules/portPool";
import type { Handlers } from "@shared/ipc/types";
import { readGlobalConfig } from "@host/lib/config/global";
import { findWorktreeIdentityOrThrow } from "@host/lib/git/worktrees";
import { isPortPoolConfigured, isPortPoolInstalled } from "@host/lib/portPool";
import { findProjectOrThrow } from "@host/lib/projects";

export const portPoolHandlers: Handlers<typeof portPoolContract> = {
  isActive: async ({ projectId, worktreeId }) => {
    const global = await readGlobalConfig();
    if (!global.portPool) return false;
    const project = findProjectOrThrow(projectId);
    const [installed, worktree] = await Promise.all([
      isPortPoolInstalled(),
      findWorktreeIdentityOrThrow(project.id, project.path, worktreeId),
    ]);
    if (!installed) return false;
    return isPortPoolConfigured(worktree.path);
  },

  isInstalled: () => isPortPoolInstalled(),
};
