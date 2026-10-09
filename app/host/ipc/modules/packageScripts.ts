import { packageScriptsContract } from "@shigomori/contracts/modules/packageScripts";
import type { Handlers } from "@shigomori/contracts/types";
import { findProjectOrThrow } from "@host/lib/projects";
import { startScript } from "@host/lib/scripts";
import {
  readLaunchRow,
  readScriptOrder,
  readScriptSort,
  writeLaunchRowScript,
  writeScriptOrder,
  writeScriptSort,
} from "@host/lib/scripts/packageScriptStats";
import { findWorktreeIdentityOrThrow } from "@host/lib/git/worktrees";
import type { HandlerContext } from "@shared/ipc/transport";
import { packageScriptLaunch, packageScripts } from "@host/lib/engineCalls";
import { scriptEventNotifier } from "../scriptRun";

export const packageScriptsHandlers: Handlers<
  typeof packageScriptsContract,
  HandlerContext
> = {
  // The worktree's scripts in manifest order (an object
  // keeps that order), the manager the lockfile selects, and each
  // script's use stats. Null when there is no readable package.json.
  list: async ({ projectId, worktreeId }) => {
    const doc = await packageScripts(projectId, worktreeId);
    if (doc === null) return null;
    return {
      scripts: Object.fromEntries(
        doc.scripts.map((script) => [script.name, script.command]),
      ),
      packageManager: doc.packageManager,
      usage: doc.usage,
      launchRow: await readLaunchRow(projectId),
    };
  },

  getSort: async ({ projectId, knowsManual }) => {
    const project = await findProjectOrThrow(projectId);
    const mode = await readScriptSort(project.id);
    return mode === "manual" && !knowsManual ? "manifest" : mode;
  },

  setSort: async ({ projectId, mode }) => {
    const project = await findProjectOrThrow(projectId);
    await writeScriptSort(project.id, mode);
  },

  getOrder: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return readScriptOrder(project.id);
  },

  setOrder: async ({ projectId, arranged }) => {
    const project = await findProjectOrThrow(projectId);
    await writeScriptOrder(project.id, arranged);
  },

  setLaunchRow: async ({ projectId, scriptName, onRow }) => {
    const project = await findProjectOrThrow(projectId);
    await writeLaunchRowScript(project.id, scriptName, onRow);
  },

  run: async ({ projectId, worktreeId, scriptName }, handlerCtx) => {
    const project = await findProjectOrThrow(projectId);
    const [worktree, doc] = await Promise.all([
      findWorktreeIdentityOrThrow(project.id, worktreeId),
      packageScripts(project.id, worktreeId),
    ]);

    // Validated here even though the engine validates again: a missing
    // script should fail this IPC call, not surface as error output in
    // an already-opened console run.
    if (!doc?.scripts.some((script) => script.name === scriptName)) {
      throw new Error(`Script "${scriptName}" is not defined in package.json`);
    }

    // The engine picks the manager and counts the run in the use log;
    // the app's registry spawns the command with the SHIGOMORI_* env.
    const { command, scriptEnv } = await packageScriptLaunch({
      projectId,
      worktreeId,
      scriptName,
    });
    const runId = startScript({
      command,
      slot: { kind: "package", name: scriptName },
      worktree,
      project,
      scriptEnv,
      notify: scriptEventNotifier(handlerCtx),
    });
    return { runId };
  },
};
