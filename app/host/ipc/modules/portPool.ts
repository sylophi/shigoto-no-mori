import { portPoolContract } from "@shigomori/contracts/modules/portPool";
import type { Handlers } from "@shigomori/contracts/types";
import {
  isPortPoolActive,
  isPortPoolEnabled,
  isPortPoolInstalled,
} from "@host/lib/portPool";
import { findWorktreePathOrThrow } from "@host/lib/projects";

export const portPoolHandlers: Handlers<typeof portPoolContract> = {
  isActive: async ({ projectId, worktreeId }) => {
    // The toggle first, before anything forks git: off is the default,
    // and a stale worktree id must answer false, not throw.
    if (!(await isPortPoolEnabled())) return false;
    return isPortPoolActive(
      await findWorktreePathOrThrow({ projectId, worktreeId }),
    );
  },

  isInstalled: () => isPortPoolInstalled(),
};
