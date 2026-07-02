import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import type { Handlers } from "@shared/ipc/types";
import { findWorktreeIdentityOrThrow } from "../../lib/git/worktrees";
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
import { prepareScriptRun, scriptEventNotifier } from "../scriptRun";
import type { HandlerContext } from "../register";

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
    const ctx = await prepareScriptRun(project, worktreeId);

    const pkg = await readPackageScripts(ctx.worktree.path);
    if (!pkg || !(scriptName in pkg.scripts)) {
      throw new Error(`Script "${scriptName}" is not defined in package.json`);
    }

    const runId = startScript({
      command: buildScriptCommand(pkg.packageManager, scriptName),
      scriptName,
      worktree: ctx.worktree,
      project,
      projectBranch: ctx.projectBranch,
      defaultBranch: ctx.defaultBranch,
      notify: scriptEventNotifier(event.sender),
    });
    bumpScriptUseCount(project.id, scriptName);
    return { runId };
  },
};
