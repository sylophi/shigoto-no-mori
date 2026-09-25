// Shared plumbing for the two script-run entry points (configured
// project scripts and package.json scripts): the connection-guarded
// notifier, and for the configured scripts, the context startScript
// needs to set the SHIGOMORI_* env (package.json scripts run through
// `sm run`, which sets it itself).
import { unknownWorktreeError } from "@shared/errors";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Project, ShigomoriConfig } from "@shared/schemas";
import { readShigomoriConfig } from "@host/lib/config/project";
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
  // One CLI read answers the worktree, the primary's branch and the
  // project's primary ref alike.
  const [config, identities] = await Promise.all([
    readShigomoriConfig(project.id),
    listWorktreeIdentities(project.id, { primaryRef: true }),
  ]);
  const worktree = identities.find((i) => i.id === worktreeId);
  if (!worktree) throw unknownWorktreeError(worktreeId);
  return {
    config,
    worktree,
    projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
    defaultBranch: worktree.primaryRef ?? "",
  };
}

export function scriptEventNotifier(ctx: HandlerContext): NotifyScriptEvent {
  return ctx.notifier(scriptsContract, "event");
}
