// Main-process orchestration of worktree create/delete lifecycles.
// Owns the sequencing of setup -> port-pool provision (on create) and
// port-pool release -> teardown (on delete), so a closed renderer
// can't leave a worktree half-torn-down. Live output keeps flowing
// to the renderer via "started" events emitted by startScript.
import type {
  CarryOverEntry,
  CarryOverFailure,
  CleanupError,
  ShigomoriConfig,
  WorktreeCarryOverComplete,
  WorktreeLifecyclePhase,
} from "@shared/schemas";
import { applyCarryOver } from "./carryOver";
import {
  mergeCarryOver,
  reconcileManualEntries,
  resolveWorktreeInclude,
  WORKTREE_INCLUDE_FILE,
} from "./worktreeInclude";
import { resolveDefaultBranch } from "../git/remotes";
import { listWorktreeIdentities } from "../git/worktrees";
import { readGlobalConfig } from "../config/global";
import { isPortPoolConfigured, isPortPoolInstalled } from "../portPool";
import { randomUUID } from "node:crypto";
import { resolveScriptCommand } from "../scripts/command";
import {
  getInflightDeleteIds,
  type NotifyScriptEvent,
  startScriptForLifecycle,
} from "../scripts";
import {
  readShigomoriConfig,
  readShigomoriConfigFresh,
  writeShigomoriConfig,
} from "../config/project";

// Renderer-bound emit callbacks supplied by the IPC handler. Keeps the
// lifecycle module Electron-free while still letting create/delete
// progress flow back to the originating window.
export type NotifyLifecyclePhase = (payload: WorktreeLifecyclePhase) => void;
export type NotifyCarryOverComplete = (
  payload: WorktreeCarryOverComplete,
) => void;

interface LifecycleWorktree {
  id: string;
  name: string;
  branch: string;
  path: string;
}

interface LifecycleProject {
  id: string;
  path: string;
  name: string;
}

interface CreateArgs {
  project: LifecycleProject;
  worktree: LifecycleWorktree;
  notifyPhase: NotifyLifecyclePhase;
  notifyCarryOverComplete: NotifyCarryOverComplete;
  notifyScript: NotifyScriptEvent;
}

async function runStep(args: {
  command: string;
  scriptName: string;
  slot:
    | { kind: "setup" }
    | { kind: "teardown" }
    | { kind: "portPool"; phase: "provision" | "release" };
  worktree: LifecycleWorktree;
  project: LifecycleProject;
  projectBranch: string;
  defaultBranch: string;
  notify: NotifyScriptEvent;
}): Promise<{ runId: string; exitCode: number | null }> {
  let started: { runId: string; exit: Promise<number | null> };
  try {
    started = startScriptForLifecycle({
      command: args.command,
      scriptName: args.scriptName,
      worktree: args.worktree,
      project: args.project,
      projectBranch: args.projectBranch,
      defaultBranch: args.defaultBranch,
      notify: args.notify,
      started: {
        slot: args.slot,
        projectId: args.project.id,
        worktreeId: args.worktree.id,
      },
    });
  } catch (err) {
    // startScript refused to spawn (unsupported cwd, app shutting
    // down). Emit the started/error/exit sequence a spawn failure
    // produces so the renderer surfaces the reason instead of the
    // lifecycle phase silently flickering back to idle.
    const runId = randomUUID();
    args.notify({
      runId,
      kind: "started",
      projectId: args.project.id,
      worktreeId: args.worktree.id,
      slot: args.slot,
    });
    args.notify({
      runId,
      kind: "error",
      data: err instanceof Error ? err.message : String(err),
    });
    args.notify({ runId, kind: "exit", code: null });
    return { runId, exitCode: null };
  }
  return { runId: started.runId, exitCode: await started.exit };
}

// Fire-and-forget after the create IPC returns. Progress flows back
// via WorktreeLifecyclePhase + WorktreeCarryOverComplete + the existing
// ScriptsEvent channel.
export async function runCreateLifecycle(args: CreateArgs): Promise<void> {
  const projectId = args.project.id;
  const worktreeId = args.worktree.id;
  // The renderer deliberately allows deleting a worktree while its setup
  // is still running; the delete path kills the running step, which
  // resolves our `await exit` and would otherwise let this chain keep
  // going -- e.g. spawning port-pool provision right after the delete's
  // port-pool release, inside a directory that's being removed. Re-check
  // before every step and bail once a delete is in flight.
  const deleting = () => getInflightDeleteIds().has(worktreeId);
  try {
    const config = await readShigomoriConfig(projectId).catch(() => null);
    if (deleting()) return;

    // .worktreeinclude resolution is best-effort like applyCarryOver: a
    // broken file must not abort creation, so its errors ride the same
    // failure report instead of throwing.
    let manualEntries = config?.carryOver ?? [];
    let includeEntries: CarryOverEntry[] = [];
    let removedCarryOverPaths: string[] | undefined;
    const includeFailures: CarryOverFailure[] = [];
    try {
      const resolution = await resolveWorktreeInclude(
        args.project.path,
        config,
      );
      if (resolution) {
        includeEntries = resolution.entries;
        // Manual entries the file now covers get auto-removed. Reconcile
        // against a fresh config read so a save that landed after our
        // cached read at the top isn't clobbered. That save may also have
        // toggled the integration off; honor the opt-out too, not just
        // the fresh carryOver list.
        const freshConfig = await readShigomoriConfigFresh(projectId);
        if (freshConfig) {
          manualEntries = freshConfig.carryOver ?? [];
          if (freshConfig.useWorktreeInclude === false) {
            includeEntries = [];
          } else {
            const { kept, removedPaths } = reconcileManualEntries(
              manualEntries,
              resolution.matchedPaths,
            );
            if (removedPaths.length > 0) {
              await writeShigomoriConfig(projectId, {
                ...freshConfig,
                carryOver: kept.length > 0 ? kept : undefined,
              });
              manualEntries = kept;
              removedCarryOverPaths = removedPaths;
            }
          }
        }
      }
    } catch (err) {
      includeFailures.push({
        path: WORKTREE_INCLUDE_FILE,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (deleting()) {
      // The reconcile write may already have landed; without the event an
      // open Configure view keeps the removed entries in its snapshot and
      // a later Save resurrects them.
      if (removedCarryOverPaths) {
        args.notifyCarryOverComplete({
          projectId,
          worktreeId,
          report: { applied: 0, failures: [] },
          removedCarryOverPaths,
        });
      }
      return;
    }

    const carryOverEntries = mergeCarryOver(manualEntries, includeEntries);
    if (carryOverEntries.length > 0 || includeFailures.length > 0) {
      args.notifyPhase({
        projectId,
        worktreeId,
        phase: "carryOver",
      });
      const report = await applyCarryOver(
        args.project.path,
        args.worktree.path,
        carryOverEntries,
      );
      args.notifyCarryOverComplete({
        projectId,
        worktreeId,
        report: {
          applied: report.applied,
          failures: report.failures,
          // Resolution errors are not entries; keep them out of the
          // per-entry failure list so toast counts stay accurate.
          includeFailures:
            includeFailures.length > 0 ? includeFailures : undefined,
        },
        removedCarryOverPaths,
      });
    }

    const setupCommand = resolveScriptCommand(
      "setup",
      config,
      args.worktree.path,
    );
    const portPoolNeeded = await willRunPortPoolProvision(args.worktree.path);

    if (!setupCommand && !portPoolNeeded) return;

    // Scripts need projectBranch (for $SHIGOMORI_PROJECT_BRANCH) and the
    // resolved default branch (for $SHIGOMORI_DEFAULT_BRANCH). Skip both
    // reads when no script will run.
    const [identities, defaultBranch] = await Promise.all([
      listWorktreeIdentities(projectId, args.project.path),
      resolveDefaultBranch(args.project.path, config?.defaultBranch).catch(
        () => "",
      ),
    ]);
    const projectBranch = identities.find((i) => i.isPrimary)?.branch ?? "";

    if (deleting()) return;

    if (setupCommand) {
      args.notifyPhase({ projectId, worktreeId, phase: "setup" });
      await runStep({
        command: setupCommand,
        scriptName: "setup",
        slot: { kind: "setup" },
        worktree: args.worktree,
        project: args.project,
        projectBranch,
        defaultBranch,
        notify: args.notifyScript,
      });
    }

    if (deleting()) return;

    if (portPoolNeeded) {
      args.notifyPhase({
        projectId,
        worktreeId,
        phase: "portPoolProvision",
      });
      await runStep({
        command: resolveScriptCommand(
          "port-pool-provision",
          config,
          args.worktree.path,
        ),
        scriptName: "port-pool-provision",
        slot: { kind: "portPool", phase: "provision" },
        worktree: args.worktree,
        project: args.project,
        projectBranch,
        defaultBranch,
        notify: args.notifyScript,
      });
    }
  } finally {
    args.notifyPhase({ projectId, worktreeId, phase: "idle" });
  }
}

async function willRunPortPoolProvision(
  worktreePath: string,
): Promise<boolean> {
  const global = await readGlobalConfig();
  if (global.portPool !== true) return false;
  const [installed, hasConfig] = await Promise.all([
    isPortPoolInstalled(),
    isPortPoolConfigured(worktreePath),
  ]);
  return installed && hasConfig;
}

interface DeleteArgs {
  project: LifecycleProject;
  worktree: LifecycleWorktree;
  projectBranch: string;
  config: ShigomoriConfig | null;
  globalPortPoolEnabled: boolean;
  notifyScript: NotifyScriptEvent;
}

// Inflight-delete marking lives in deleteWorktreeWithCleanup (the sole
// caller), which wraps the whole delete -- cleanup scripts AND the actual
// removal -- so the busy-quit prompt can't miss the removal phase.
export async function runDeleteCleanup(args: DeleteArgs): Promise<void> {
  const defaultBranch = await resolveDefaultBranch(
    args.project.path,
    args.config?.defaultBranch,
  ).catch(() => "");

  if (args.globalPortPoolEnabled) {
    const [installed, hasConfig] = await Promise.all([
      isPortPoolInstalled(),
      isPortPoolConfigured(args.worktree.path),
    ]);
    if (installed && hasConfig) {
      const { runId, exitCode } = await runStep({
        command: resolveScriptCommand(
          "port-pool-release",
          args.config,
          args.worktree.path,
        ),
        scriptName: "port-pool-release",
        slot: { kind: "portPool", phase: "release" },
        worktree: args.worktree,
        project: args.project,
        projectBranch: args.projectBranch,
        defaultBranch,
        notify: args.notifyScript,
      });
      if (exitCode !== 0) {
        throw cleanupError("portPoolRelease", exitCode, runId);
      }
    }
  }

  const teardownCommand = resolveScriptCommand(
    "teardown",
    args.config,
    args.worktree.path,
  );
  if (teardownCommand) {
    const { runId, exitCode } = await runStep({
      command: teardownCommand,
      scriptName: "teardown",
      slot: { kind: "teardown" },
      worktree: args.worktree,
      project: args.project,
      projectBranch: args.projectBranch,
      defaultBranch,
      notify: args.notifyScript,
    });
    if (exitCode !== 0) {
      throw cleanupError("teardown", exitCode, runId);
    }
  }
}

function cleanupError(
  phase: CleanupError["phase"],
  exitCode: number | null,
  runId: string,
): Error & CleanupError {
  const err = new Error(
    `${phase} ${
      exitCode === null ? "errored" : `exited with code ${exitCode}`
    }`,
  ) as Error & CleanupError;
  err.phase = phase;
  err.exitCode = exitCode;
  err.runId = runId;
  return err;
}
