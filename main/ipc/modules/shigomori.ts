import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import type { Handlers } from "@shared/ipc/types";
import {
  invalidateProjectConfigCache,
  readShigomoriConfig,
  readWorktreeData,
  writeWorktreeData,
} from "../../lib/config/project";
import { findProjectOrThrow } from "../../lib/projects";
import { shigomoriWriteViaCli } from "../cliDelegate";

export const shigomoriHandlers: Handlers<typeof shigomoriContract> = {
  read: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return readShigomoriConfig(project.id);
  },

  write: async ({ projectId, config }) => {
    // Same engine rule as the other mutations: the CLI performs the
    // write (it also handles the in-project exclude side effect and
    // validates projectId, mapping onto the same unknown-project
    // error).
    await shigomoriWriteViaCli(projectId, config);
    // The watcher treats the delegated spawn as a self-write, so the
    // TTL cache must be dropped here rather than by the fs event.
    invalidateProjectConfigCache(projectId);
  },

  worktreeDataRead: async ({ projectId, worktreeId }) => {
    // Validate projectId against the in-memory project list before any
    // path construction, so a bogus id can't read outside projects/.
    findProjectOrThrow(projectId);
    return readWorktreeData(projectId, worktreeId);
  },

  worktreeDataWrite: async ({ projectId, worktreeId, data }) => {
    // The renderer only surfaces a notes UI for managed worktrees and the
    // primary checkout, so we don't re-verify here -- enforcing the "no
    // external state" rule would mean shelling out to `git worktree list`
    // on every save. findProjectOrThrow + the WorktreeIdSchema regex keep
    // the path-build safe against malformed input.
    findProjectOrThrow(projectId);
    await writeWorktreeData(projectId, worktreeId, data);
  },
};
