import type { ScriptName, ShigomoriConfig } from "@shared/schemas";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import type { Handlers } from "@shared/ipc/types";
import { findProjectOrThrow } from "../../lib/projects";
import {
  cancelScript,
  resizeScript,
  startScript,
  writeToScript,
} from "../../lib/scripts";
import { takeOrphanSweepReport } from "../../lib/scripts/persistence";
import { shellQuote } from "../../lib/scripts/process";
import { prepareScriptRun, scriptEventNotifier } from "../scriptRun";
import type { HandlerContext } from "../register";

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
    run: async ({ projectId, worktreeId, script }, { event }) => {
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
        notify: scriptEventNotifier(event.sender),
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
  };
