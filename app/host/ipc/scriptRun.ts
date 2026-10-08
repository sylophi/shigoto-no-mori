// Shared plumbing for the two script-run entry points (configured
// project scripts and package.json scripts): the connection-guarded
// notifier, and for the configured scripts, the context startScript
// needs to set the SHIGOMORI_* env (package.json scripts run through
// `sm run`, which sets it itself).
import { unknownWorktreeError } from "@shigomori/contracts/errors";
import { hasWorktreeData } from "@shigomori/contracts/schemas";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Project, ShigomoriConfig } from "@shigomori/contracts/schemas";
import {
  readShigomoriConfig,
  readWorktreeData,
} from "@host/lib/config/project";
import {
  listWorktreeIdentities,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import type { NotifyScriptEvent, ScriptEnvValues } from "@host/lib/scripts";

export interface ScriptRunContext {
  config: ShigomoriConfig | null;
  worktree: WorktreeIdentity;
  scriptEnv: ScriptEnvValues;
}

export async function prepareScriptRun(
  project: Pick<Project, "id" | "path">,
  worktreeId: string,
): Promise<ScriptRunContext> {
  // One CLI read answers the worktree, the primary's branch and the
  // project's primary ref alike. The data file is read alongside it and
  // dropped below for an external worktree, which keeps none (the
  // CLI's describedOf). A broken one costs the run its title, not the
  // run.
  const [config, identities, data] = await Promise.all([
    readShigomoriConfig(project.id),
    listWorktreeIdentities(project.id, { primaryRef: true }),
    readWorktreeData(project.id, worktreeId).catch(() => null),
  ]);
  const worktree = identities.find((i) => i.id === worktreeId);
  if (!worktree) throw unknownWorktreeError(worktreeId);
  const described = hasWorktreeData(worktree) ? data : null;
  return {
    config,
    worktree,
    scriptEnv: {
      projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
      defaultBranch: worktree.primaryRef ?? "",
      title: withoutNul(described?.title),
      description: withoutNul(described?.description),
    },
  };
}

// Free text, and a spawn refuses an env value that holds a NUL, so one
// stray byte would keep the script from starting (the CLI's scriptEnv
// drops them too).
function withoutNul(text: string | undefined): string {
  return (text ?? "").replaceAll("\0", "");
}

export function scriptEventNotifier(ctx: HandlerContext): NotifyScriptEvent {
  return Object.assign(ctx.notifier(scriptsContract, "event"), {
    connection: ctx.signal,
  });
}
