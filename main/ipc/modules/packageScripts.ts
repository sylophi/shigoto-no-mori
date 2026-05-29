import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import type { Handlers } from "@shared/ipc/types";
import type { ScriptEvent } from "@shared/schemas";
import { readShigomoriConfig } from "../../lib/config/project";
import { resolveDefaultBranch } from "../../lib/git/remotes";
import {
  findWorktreeIdentityOrThrow,
  listWorktreeIdentities,
} from "../../lib/git/worktrees";
import { findProjectOrThrow } from "../../lib/projects";
import { startScript } from "../../lib/scripts";
import {
  bumpScriptUseCount,
  readScriptSort,
  usageFor,
  writeScriptSort,
} from "../../lib/scripts/packageScriptStats";
import {
  buildScriptCommand,
  readPackageScripts,
} from "../../lib/scripts/packageScripts";
import { broadcast, type HandlerContext } from "../register";

export const packageScriptsHandlers: Handlers<
  typeof packageScriptsContract,
  HandlerContext
> = {
  list: async ({ projectId, worktreeId }) => {
    const project = findProjectOrThrow(projectId);
    const worktree = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    const file = await readPackageScripts(worktree.path);
    if (!file) return null;
    return {
      ...file,
      usage: usageFor(project.id, Object.keys(file.scripts)),
    };
  },

  getSort: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return readScriptSort(project.id);
  },

  setSort: async ({ projectId, mode }) => {
    const project = findProjectOrThrow(projectId);
    writeScriptSort(project.id, mode);
  },

  run: async ({ projectId, worktreeId, scriptName }, { event }) => {
    const project = findProjectOrThrow(projectId);

    const [config, identities] = await Promise.all([
      readShigomoriConfig(project.id),
      listWorktreeIdentities(project.id, project.path),
    ]);
    const worktree = identities.find((i) => i.id === worktreeId);
    if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);

    const [defaultBranch, pkg] = await Promise.all([
      resolveDefaultBranch(project.path, config?.defaultBranch).catch(() => ""),
      readPackageScripts(worktree.path),
    ]);
    if (!pkg || !(scriptName in pkg.scripts)) {
      throw new Error(`Script "${scriptName}" is not defined in package.json`);
    }

    const command = buildScriptCommand(pkg.packageManager, scriptName);
    const sender = event.sender;
    const notify = (payload: ScriptEvent) => {
      if (sender.isDestroyed()) return;
      broadcast(scriptsContract, "event", payload, sender);
    };
    const runId = startScript({
      command,
      scriptName,
      worktree,
      project,
      projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
      defaultBranch,
      notify,
    });
    bumpScriptUseCount(project.id, scriptName);
    return { runId };
  },
};
