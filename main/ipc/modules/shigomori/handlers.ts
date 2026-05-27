import { shigomoriContract } from "@shared/ipc/modules/shigomori/contract";
import type { Handlers } from "@shared/ipc/types";
import { IN_PROJECT_ROOT_DIR } from "@shared/worktreeLayout";
import {
  readShigomoriConfig,
  readWorktreeData,
  writeShigomoriConfig,
  writeWorktreeData,
} from "../../../lib/config/project";
import { appendExcludes } from "../../../lib/git/exclude";
import { findProjectOrThrow } from "../../../lib/projects";

export const shigomoriHandlers: Handlers<typeof shigomoriContract> = {
  read: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return readShigomoriConfig(project.id);
  },

  write: async ({ projectId, config }) => {
    const project = findProjectOrThrow(projectId);
    await writeShigomoriConfig(projectId, config);
    // Hide `.shigomori/` from the primary's `git status` whenever the
    // project opts into the in-project layout. Idempotent: appendExcludes
    // skips lines that already exist.
    if (config.worktreeLayout === "in-project") {
      try {
        await appendExcludes(project.path, [IN_PROJECT_ROOT_DIR]);
      } catch (err) {
        // Non-fatal: the user can still use the layout, they'll just see
        // .shigomori/ in their git status until they exclude it manually.
        console.warn(
          `[shigomori] couldn't append ${IN_PROJECT_ROOT_DIR} to info/exclude:`,
          err,
        );
      }
    }
  },

  worktreeDataRead: async ({ projectId, worktreeId }) => {
    // Validate projectId against the in-memory project list before any
    // path construction, so a bogus id can't read outside projects/.
    findProjectOrThrow(projectId);
    return readWorktreeData(projectId, worktreeId);
  },

  worktreeDataWrite: async ({ projectId, worktreeId, data }) => {
    // The renderer doesn't surface a notes UI for external worktrees, so
    // we don't re-verify here -- enforcing the "no external state" rule
    // would mean shelling out to `git worktree list` on every save.
    // findProjectOrThrow + the WorktreeIdSchema regex keep the path-build
    // safe against malformed input.
    findProjectOrThrow(projectId);
    await writeWorktreeData(projectId, worktreeId, data);
  },
};
