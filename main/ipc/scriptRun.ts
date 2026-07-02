// Shared plumbing for the two script-run entry points (configured
// project scripts and package.json scripts). Both need the same
// project-level context resolved before startScript, and the same
// destroyed-sender-guarded notifier; only command resolution differs.
import type { WebContents } from "electron";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import type { Project, ScriptEvent, ShigomoriConfig } from "@shared/schemas";
import { readShigomoriConfig } from "../lib/config/project";
import { resolveDefaultBranch } from "../lib/git/remotes";
import {
  listWorktreeIdentities,
  type WorktreeIdentity,
} from "../lib/git/worktrees";
import type { NotifyScriptEvent } from "../lib/scripts";
import { broadcast } from "./register";

export interface ScriptRunContext {
  config: ShigomoriConfig | null;
  worktree: WorktreeIdentity;
  // Branch checked out in the primary worktree; "" when there is none.
  projectBranch: string;
  // "" when the default branch can't be resolved (no remote, empty repo).
  defaultBranch: string;
}

export async function prepareScriptRun(
  project: Pick<Project, "id" | "path">,
  worktreeId: string,
): Promise<ScriptRunContext> {
  const [config, identities] = await Promise.all([
    readShigomoriConfig(project.id),
    listWorktreeIdentities(project.id, project.path),
  ]);
  const worktree = identities.find((i) => i.id === worktreeId);
  if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);
  const defaultBranch = await resolveDefaultBranch(
    project.path,
    config?.defaultBranch,
  ).catch(() => "");
  return {
    config,
    worktree,
    projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
    defaultBranch,
  };
}

// Script events outlive navigation and window close; the guard keeps a
// long-running script from broadcasting into a destroyed sender.
export function scriptEventNotifier(sender: WebContents): NotifyScriptEvent {
  return (payload: ScriptEvent) => {
    if (sender.isDestroyed()) return;
    broadcast(scriptsContract, "event", payload, sender);
  };
}
