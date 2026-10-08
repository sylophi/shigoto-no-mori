import {
  lifecycleSlot,
  type ScriptName,
  type ShigomoriConfig,
} from "@shigomori/contracts/schemas";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import type { Handlers } from "@shigomori/contracts/types";
import { findProjectOrThrow } from "@host/lib/projects";
import {
  attachScript,
  cancelScript,
  listRunningScripts,
  resizeScript,
  startScript,
  writeToScript,
} from "@host/lib/scripts";
import { takeOrphanSweepReport } from "@host/lib/scripts/persistence";
import { shellQuote } from "@host/lib/util/shellQuote";
import type { HandlerContext } from "@shared/ipc/transport";
import { prepareScriptRun, scriptEventNotifier } from "../scriptRun";

// The shell command behind each ScriptName.
function resolveScriptCommand(
  script: ScriptName,
  config: ShigomoriConfig | null,
  worktreePath: string,
): string {
  switch (script) {
    case "setup":
      return config?.scripts?.setup?.trim() ?? "";
    case "teardown":
      return config?.scripts?.teardown?.trim() ?? "";
    case "port-pool-provision":
      return `port-pool provision ${shellQuote(worktreePath)}`;
    case "port-pool-release":
      return `port-pool release ${shellQuote(worktreePath)}`;
  }
}

export const scriptsHandlers: Handlers<typeof scriptsContract, HandlerContext> =
  {
    run: async ({ projectId, worktreeId, script }, handlerCtx) => {
      const project = await findProjectOrThrow(projectId);
      const ctx = await prepareScriptRun(project, worktreeId);

      const command = resolveScriptCommand(
        script,
        ctx.config,
        ctx.worktree.path,
      );
      if (!command) {
        throw new Error(`No "${script}" script configured for ${project.name}`);
      }

      const runId = startScript({
        command,
        slot: lifecycleSlot(script),
        worktree: ctx.worktree,
        project,
        scriptEnv: ctx.scriptEnv,
        notify: scriptEventNotifier(handlerCtx),
      });
      return { runId };
    },

    cancel: async ({ runId }) => {
      const cancelled = await cancelScript(runId);
      return { cancelled };
    },

    write: async ({ runId, data }) => writeToScript(runId, data),

    resize: async ({ runId, cols, rows }) => resizeScript(runId, cols, rows),

    orphanReport: async () => takeOrphanSweepReport(),

    list: async () => ({ runs: listRunningScripts() }),

    attach: async ({ runId }, handlerCtx) =>
      attachScript(runId, scriptEventNotifier(handlerCtx)),
  };
