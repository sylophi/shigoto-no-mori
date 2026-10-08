import type { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import type { Handlers } from "@shigomori/contracts/types";
import {
  readWorktreeData,
  writeWorktreeData,
  writeWorktreeDescription,
} from "@host/lib/config/project";
import { findProjectOrThrow } from "@host/lib/projects";

export const worktreeDataHandlers: Handlers<typeof worktreeDataContract> = {
  read: async ({ projectId, worktreeId }) => {
    // Validate projectId against the in-memory project list before any
    // path construction, so a bogus id can't read outside projects/.
    await findProjectOrThrow(projectId);
    return readWorktreeData(projectId, worktreeId);
  },

  write: async ({ projectId, worktreeId, data }) => {
    // The renderer only surfaces a ports editor for managed worktrees
    // and the primary checkout, so we don't re-verify here. Enforcing the "no
    // external state" rule would mean asking the CLI for the worktree
    // list on every save. findProjectOrThrow + the WorktreeIdSchema regex keep
    // the path-build safe against malformed input.
    await findProjectOrThrow(projectId);
    await writeWorktreeData(projectId, worktreeId, data);
  },

  describe: async ({ projectId, worktreeId, description }) => {
    await findProjectOrThrow(projectId);
    await writeWorktreeDescription(projectId, worktreeId, description);
  },
};
