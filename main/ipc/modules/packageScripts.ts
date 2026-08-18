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
  readPackageScriptNames,
  readPackageScripts,
} from "../../lib/scripts/packageScripts";
import { cliRunScriptSpawn } from "../cliDelegate";
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

    // Validated here even though the CLI validates again: a missing
    // script should fail this IPC call, not surface as error output in
    // an already-opened console run.
    const scripts = await readPackageScriptNames(ctx.worktree.path);
    if (!scripts || !(scriptName in scripts)) {
      throw new Error(`Script "${scriptName}" is not defined in package.json`);
    }

    // `sm run` is the engine: it detects the manager and injects the
    // script env. The use log is bumped here, in-process (the CLI
    // child is told --skip-use-log), so the state watcher sees a
    // suppressible self-write instead of an external state.json change
    // on every run.
    const command = cliRunScriptSpawn({
      projectId,
      worktreeId,
      scriptName,
      projectBranch: ctx.projectBranch,
      defaultBranch: ctx.defaultBranch,
    });
    const runId = startScript({
      command,
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
