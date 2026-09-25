import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import type { Handlers } from "@shared/ipc/types";
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
import { noteSelfWrite } from "@host/lib/util/selfWrite";
import type { HandlerContext } from "@shared/ipc/transport";
import { cliRunScriptSpawn, packageScriptsViaCli } from "../cliDelegate";
import { scriptEventNotifier } from "../scriptRun";

export const packageScriptsHandlers: Handlers<
  typeof packageScriptsContract,
  HandlerContext
> = {
  // `sm run` with no script: the scripts in manifest order (an object
  // keeps that order), the manager the lockfile selects, and each
  // script's use stats. Null when there is no readable package.json.
  list: async ({ projectId, worktreeId }) => {
    const doc = await packageScriptsViaCli(projectId, worktreeId);
    if (doc === null) return null;
    return {
      scripts: Object.fromEntries(
        doc.scripts.map((script) => [script.name, script.command]),
      ),
      packageManager: doc.packageManager,
      usage: doc.usage,
      launchRow: readLaunchRow(projectId),
    };
  },

  getSort: async ({ projectId, knowsManual }) => {
    const project = await findProjectOrThrow(projectId);
    const mode = readScriptSort(project.id);
    return mode === "manual" && !knowsManual ? "manifest" : mode;
  },

  setSort: async ({ projectId, mode }) => {
    const project = await findProjectOrThrow(projectId);
    writeScriptSort(project.id, mode);
  },

  getOrder: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return readScriptOrder(project.id);
  },

  setOrder: async ({ projectId, arranged }) => {
    const project = await findProjectOrThrow(projectId);
    writeScriptOrder(project.id, arranged);
  },

  setLaunchRow: async ({ projectId, scriptName, onRow }) => {
    const project = await findProjectOrThrow(projectId);
    writeLaunchRowScript(project.id, scriptName, onRow);
  },

  run: async ({ projectId, worktreeId, scriptName }, handlerCtx) => {
    const project = await findProjectOrThrow(projectId);
    const [worktree, doc] = await Promise.all([
      findWorktreeIdentityOrThrow(project.id, worktreeId),
      packageScriptsViaCli(project.id, worktreeId),
    ]);

    // Validated here even though the CLI validates again: a missing
    // script should fail this IPC call, not surface as error output in
    // an already-opened console run.
    if (!doc?.scripts.some((script) => script.name === scriptName)) {
      throw new Error(`Script "${scriptName}" is not defined in package.json`);
    }

    // `sm run` is the engine: it picks the manager, sets the
    // SHIGOMORI_* env and counts the run in the use log. That count is
    // a state.json write from a child the app started, landing moments
    // after the spawn, so it is noted as the app's own: the state
    // watcher would otherwise answer every run with an app-wide
    // refetch.
    const command = cliRunScriptSpawn({ projectId, worktreeId, scriptName });
    const runId = startScript({
      command,
      scriptName,
      worktree,
      project,
      notify: scriptEventNotifier(handlerCtx),
    });
    noteSelfWrite();
    return { runId };
  },
};
