import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import type { Handlers } from "@shared/ipc/types";
import { IN_PROJECT_ROOT_DIR } from "@shared/worktreeLayout";
import { cliAvailable } from "../../electron/cliRunner";
import {
  invalidateProjectConfigCache,
  readShigomoriConfig,
  readWorktreeData,
  writeShigomoriConfig,
  writeWorktreeData,
} from "../../lib/config/project";
import { appendExcludes } from "../../lib/git/exclude";
import { findProjectOrThrow } from "../../lib/projects";
import { shigomoriWriteViaCli } from "../cliDelegate";

export const shigomoriHandlers: Handlers<typeof shigomoriContract> = {
  read: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return readShigomoriConfig(project.id);
  },

  write: async ({ projectId, config }) => {
    // Same engine rule as the other mutations: delegate to the CLI when
    // available (it also performs the in-project exclude side effect
    // and validates projectId, mapping onto the same unknown-project
    // error).
    if (cliAvailable()) {
      await shigomoriWriteViaCli(projectId, config);
      // The watcher treats the delegated spawn as a self-write, so the
      // TTL cache must be dropped here rather than by the fs event.
      invalidateProjectConfigCache(projectId);
      return;
    }
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
    // The renderer only surfaces a notes UI for managed worktrees and the
    // primary checkout, so we don't re-verify here -- enforcing the "no
    // external state" rule would mean shelling out to `git worktree list`
    // on every save. findProjectOrThrow + the WorktreeIdSchema regex keep
    // the path-build safe against malformed input.
    findProjectOrThrow(projectId);
    await writeWorktreeData(projectId, worktreeId, data);
  },
};
