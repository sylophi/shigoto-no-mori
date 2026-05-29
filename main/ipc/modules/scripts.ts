import { scriptsContract } from "@shared/ipc/modules/scripts";
import type { Handlers } from "@shared/ipc/types";
import type { ScriptEvent } from "@shared/schemas";
import { readShigomoriConfig } from "../../lib/config/project";
import { resolveDefaultBranch } from "../../lib/git/remotes";
import { listWorktreeIdentities } from "../../lib/git/worktrees";
import { findProjectOrThrow } from "../../lib/projects";
import { cancelScript, startScript } from "../../lib/scripts";
import { resolveScriptCommand } from "../../lib/scripts/command";
import { broadcast, type HandlerContext } from "../register";

export const scriptsHandlers: Handlers<typeof scriptsContract, HandlerContext> =
  {
    run: async ({ projectId, worktreeId, script }, { event }) => {
      const project = findProjectOrThrow(projectId);
      const config = await readShigomoriConfig(project.id);

      const [identities, defaultBranch] = await Promise.all([
        listWorktreeIdentities(project.id, project.path),
        resolveDefaultBranch(project.path, config?.defaultBranch).catch(
          () => "",
        ),
      ]);
      const worktree = identities.find((i) => i.id === worktreeId);
      if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);

      const command = resolveScriptCommand(script, config, worktree.path);
      if (!command) {
        throw new Error(`No "${script}" script configured for ${project.name}`);
      }

      const sender = event.sender;
      const notify = (payload: ScriptEvent) => {
        if (sender.isDestroyed()) return;
        broadcast(scriptsContract, "event", payload, sender);
      };

      const runId = startScript({
        command,
        scriptName: script,
        worktree,
        project,
        projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
        defaultBranch,
        notify,
      });
      return { runId };
    },

    cancel: async ({ runId }) => {
      const cancelled = await cancelScript(runId);
      return { cancelled };
    },
  };
