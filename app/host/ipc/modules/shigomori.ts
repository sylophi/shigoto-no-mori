import type { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import type { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import type { Handlers } from "@shigomori/contracts/types";
import {
  invalidateProjectConfigCache,
  readShigomoriConfig,
  readWorktreeData,
  writeWorktreeData,
  writeWorktreeDescription,
} from "@host/lib/config/project";
import { findProjectOrThrow } from "@host/lib/projects";
import { shigomoriWriteViaCli } from "../cliDelegate";

export const shigomoriHandlers: Handlers<typeof shigomoriContract> = {
  // project.json as stored, read through the CLI (`sm projects config
  // read`), which answers an unknown project id with the entity-gone
  // error. Cached for a few seconds (host/lib/config/project.ts).
  read: ({ projectId }) => readShigomoriConfig(projectId),

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
};

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
