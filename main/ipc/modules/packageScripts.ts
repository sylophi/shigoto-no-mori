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
    const pkg = await readPackageScripts(ctx.worktree.path);
    if (!pkg || !(scriptName in pkg.scripts)) {
      throw new Error(`Script "${scriptName}" is not defined in package.json`);
    }

    // `sm run` is the engine when the CLI is available: it detects the
    // manager and injects the script env. Windows / missing binary
    // fall back to the TS builder. The use log is always bumped here,
    // in-process (the CLI child is told --skip-use-log), so the state
    // watcher sees a suppressible self-write instead of an external
    // state.json change on every run.
    const viaCli = cliRunScriptSpawn({
      projectId,
      worktreeId,
      scriptName,
      projectBranch: ctx.projectBranch,
      defaultBranch: ctx.defaultBranch,
    });
    const runId = startScript({
      command:
        viaCli?.command ?? buildScriptCommand(pkg.packageManager, scriptName),
      extraEnv: viaCli?.env,
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
