// Shared plumbing for the two script-run entry points (configured
// project scripts and package.json scripts): the connection-guarded
// notifier, and for the configured scripts, the context a run
// needs to set the SHIGOMORI_* env (a package.json script's comes
// from the engine with its command). A worktree's terminal starts with
// the same env.
import * as Effect from "effect/Effect";
import {
  isEntityGoneError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import { hasWorktreeData } from "@shigomori/contracts/schemas";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type { HandlerContext } from "@shared/ipc/transport";
import type {
  Project,
  ShigomoriConfig,
  WorktreeIdentity,
} from "@shigomori/contracts/schemas";
import * as EngineConfig from "@shigomori/engine/Config";
import type * as Registry from "@shigomori/engine/Registry";
import * as EngineWorktrees from "@shigomori/engine/Worktrees";
import { findProject } from "@host/lib/projects";
import type { NotifyScriptEvent, ScriptEnvValues } from "@host/lib/Scripts";
import { scriptEnvOf } from "@shigomori/contracts/scriptEnv";
import type { Start } from "@host/lib/terminals/Terminals";
import * as WorktreeData from "@shigomori/engine/WorktreeData";

interface ScriptRunContext {
  config: ShigomoriConfig | null;
  worktree: WorktreeIdentity;
  scriptEnv: ScriptEnvValues;
}

export const prepareScriptRun = Effect.fnUntraced(function* (
  project: Pick<Project, "id" | "path">,
  worktreeId: string,
) {
  // One engine read answers the worktree, the primary's branch and the
  // project's primary ref alike. The data is read alongside it and
  // dropped below for an external worktree, which keeps none (the
  // engine's describedOf). A broken one costs the run its title, not
  // the run.
  const registered = yield* findProject(project.id);
  const [config, identities, data] = yield* Effect.all(
    [
      Effect.flatMap(EngineConfig.Config, (engineConfig) =>
        engineConfig.readProject(EngineConfig.projectScope(registered)),
      ),
      identitiesOf(registered, true),
      Effect.flatMap(WorktreeData.WorktreeData, (worktreeData) =>
        worktreeData.document(project.id, worktreeId),
      ).pipe(Effect.orElseSucceed(() => null)),
    ],
    { concurrency: 3 },
  );
  const worktree = identities.find((i) => i.id === worktreeId);
  if (!worktree) return yield* new UnknownWorktreeError({ worktreeId });
  const described = hasWorktreeData(worktree) ? data : null;
  return {
    config,
    worktree,
    scriptEnv: {
      projectBranch: identities.find((i) => i.isPrimary)?.branch ?? "",
      defaultBranch: worktree.primaryRef ?? "",
      title: described?.title ?? "",
      description: described?.description ?? "",
    },
  } satisfies ScriptRunContext;
});

export function scriptEventNotifier(ctx: HandlerContext): NotifyScriptEvent {
  return Object.assign(ctx.notifier(scriptsContract, "event"), {
    connection: ctx.connection,
  });
}

// What a create's run tells the calling window or peer as it goes.
export function worktreeNotifiers(ctx: HandlerContext) {
  return {
    notifyPhase: ctx.notifier(worktreesContract, "lifecyclePhase"),
    notifyCarryOverComplete: ctx.notifier(
      worktreesContract,
      "carryOverComplete",
    ),
    notifyScript: scriptEventNotifier(ctx),
  };
}

// Where a terminal starts (host/lib/terminals): in its worktree's
// folder with its scripts' SHIGOMORI_* env. TERM and COLORTERM say what
// xterm in the renderer draws.
export const terminalStart = (owner: {
  readonly projectId: string;
  readonly worktreeId: string;
}) =>
  Effect.gen(function* () {
    const project = yield* findProject(owner.projectId);
    const ctx = yield* prepareScriptRun(project, owner.worktreeId);
    return {
      cwd: ctx.worktree.path,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...scriptEnvOf({ worktree: ctx.worktree, project, ...ctx.scriptEnv }),
      },
    } satisfies Start;
  }).pipe(
    // Anything but the worktree or project being gone is a defect.
    Effect.catchIf(
      (cause) => !isEntityGoneError(cause),
      (cause) => Effect.die(cause),
    ),
  );

// A project's identities, primary first.
const identitiesOf = (
  project: Registry.RegisteredProject,
  primaryRef: boolean,
) =>
  Effect.flatMap(EngineWorktrees.Worktrees, (worktrees) =>
    Effect.map(
      worktrees.identityList([project], { primaryRef }),
      ({ rows }) => rows,
    ),
  );

// The worktrees a project's terminals may stay in.
export const terminalWorktrees = (projectId: string) =>
  Effect.flatMap(findProject(projectId), (project) =>
    identitiesOf(project, false),
  );
