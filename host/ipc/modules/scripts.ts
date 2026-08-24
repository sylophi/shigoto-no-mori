import type { ScriptName, ShigomoriConfig } from "@shared/schemas";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import type { Handlers } from "@shared/ipc/types";
import { findProjectOrThrow } from "@host/lib/projects";
import { cancelScript, startScript } from "@host/lib/scripts";
import { takeOrphanSweepReport } from "@host/lib/scripts/persistence";
import { shellQuote } from "@host/lib/scripts/process";
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
      const project = findProjectOrThrow(projectId);
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
        scriptName: script,
        worktree: ctx.worktree,
        project,
        projectBranch: ctx.projectBranch,
        defaultBranch: ctx.defaultBranch,
        notify: scriptEventNotifier(handlerCtx),
      });
      return { runId };
    },

    cancel: async ({ runId }) => {
      const cancelled = await cancelScript(runId);
      return { cancelled };
    },

    orphanReport: async () => takeOrphanSweepReport(),
  };
