// Shared plumbing for the two script-run entry points (configured
// project scripts and package.json scripts). Both need the same
// project-level context resolved before startScript, and the same
// connection-guarded notifier. Only command resolution differs.
import { unknownWorktreeError } from "@shared/errors";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Project, ShigomoriConfig } from "@shared/schemas";
import { readShigomoriConfig } from "@host/lib/config/project";
import { resolveDefaultBranch } from "@host/lib/git/remotes";
import {
  listWorktreeIdentities,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import type { NotifyScriptEvent } from "@host/lib/scripts";

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
  // The default-branch resolution only needs the config, so chain it off
  // that read rather than the full join -- resolveDefaultBranch spawns
  // several sequential git calls and shouldn't wait on the worktree list.
  const configPromise = readShigomoriConfig(project.id);
  const [config, identities, defaultBranch] = await Promise.all([
    configPromise,
    listWorktreeIdentities(project.id, project.path),
    configPromise
      .then((c) => resolveDefaultBranch(project.path, c?.defaultBranch))
      .catch(() => ""),
  ]);
  const worktree = identities.find((i) => i.id === worktreeId);
  if (!worktree) throw unknownWorktreeError(worktreeId);
  return {
    config,
    worktree,
    projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
    defaultBranch,
  };
}

export function scriptEventNotifier(ctx: HandlerContext): NotifyScriptEvent {
  return ctx.notifier(scriptsContract, "event");
}
