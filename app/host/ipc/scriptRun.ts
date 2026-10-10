// Shared plumbing for the two script-run entry points (configured
// project scripts and package.json scripts): the connection-guarded
// notifier, and for the configured scripts, the context startScript
// needs to set the SHIGOMORI_* env (package.json scripts run through
// `sm run`, which sets it itself). A worktree's terminal starts with
// the same env.
import * as Effect from "effect/Effect";
import {
  isEntityGoneError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import { hasWorktreeData } from "@shigomori/contracts/schemas";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import type { HandlerContext } from "@shared/ipc/transport";
import type {
  Project,
  ShigomoriConfig,
  TerminalOwner,
} from "@shigomori/contracts/schemas";
import { findProjectOrThrow } from "@host/lib/projects";
import {
  readShigomoriConfig,
  readWorktreeData,
} from "@host/lib/config/project";
import {
  listWorktreeIdentities,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import {
  type NotifyScriptEvent,
  type ScriptEnvValues,
  worktreeEnv,
} from "@host/lib/scripts";
import type { Start } from "@host/lib/terminals/Terminals";

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
  if (!worktree) throw new UnknownWorktreeError({ worktreeId });
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
    connection: ctx.connection,
  });
}

// Where a terminal starts (host/lib/terminals): a worktree's in its
// folder with its scripts' SHIGOMORI_* env, a device's with the app's
// own. TERM and COLORTERM say what xterm in the renderer draws.
export const terminalStart = (owner: TerminalOwner) => {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  if (owner.kind === "device") return Effect.succeed<Start>({ env });
  return Effect.tryPromise({
    try: async (): Promise<Start> => {
      const project = await findProjectOrThrow(owner.projectId);
      const ctx = await prepareScriptRun(project, owner.worktreeId);
      return {
        cwd: ctx.worktree.path,
        env: { ...env, ...worktreeEnv(ctx.worktree, project, ctx.scriptEnv) },
      };
    },
    // Anything but the worktree or project being gone is a defect.
    catch: (cause) => {
      if (isEntityGoneError(cause)) return cause;
      throw cause;
    },
  });
};
