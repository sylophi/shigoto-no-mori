// Main-process orchestration of worktree create/delete lifecycles.
// Owns the sequencing of setup -> port-pool provision (on create) and
// port-pool release -> teardown (on delete), so a closed renderer
// can't leave a worktree half-torn-down. Live output keeps flowing
// to the renderer via "started" events emitted by startScript.
import type { WebContents } from "electron";
import { CHANNELS } from "@shared/channels";
import type {
  CarryOverEntry,
  CarryOverReport,
  CleanupError,
  ShigomoriConfig,
  WorktreeCarryOverComplete,
  WorktreeLifecyclePhase,
} from "@shared/schemas";
import { applyCarryOver } from "./carryOver";
import { resolveDefaultBranch } from "./git";
import { isPortPoolConfigured, isPortPoolInstalled } from "./portPool";
import { resolveScriptCommand } from "./scriptCommand";
import {
  clearDeleteInflight,
  markDeleteInflight,
  startScriptForLifecycle,
} from "./scripts";

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
  projectBranch: string;
  config: ShigomoriConfig | null;
  carryOverEntries: CarryOverEntry[];
  primaryWorktreePath: string;
  globalPortPoolEnabled: boolean;
  webContents: WebContents;
}

function emitPhase(
  webContents: WebContents,
  payload: WorktreeLifecyclePhase,
): void {
  if (webContents.isDestroyed()) return;
  webContents.send(CHANNELS.WorktreeLifecyclePhase, payload);
}

function emitCarryOverComplete(
  webContents: WebContents,
  payload: WorktreeCarryOverComplete,
): void {
  if (webContents.isDestroyed()) return;
  webContents.send(CHANNELS.WorktreeCarryOverComplete, payload);
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
  webContents: WebContents;
}): Promise<{ runId: string; exitCode: number | null }> {
  const { runId, exit } = startScriptForLifecycle({
    command: args.command,
    scriptName: args.scriptName,
    worktree: args.worktree,
    project: args.project,
    projectBranch: args.projectBranch,
    defaultBranch: args.defaultBranch,
    webContents: args.webContents,
    started: {
      slot: args.slot,
      projectId: args.project.id,
      worktreeId: args.worktree.id,
    },
  });
  return { runId, exitCode: await exit };
}

// Runs in the background after the IPC handler returns. The renderer
// reflects progress via two channels: WorktreeLifecyclePhase for the
// banner label, and WorktreeCarryOverComplete for the failure toast.
// Per-script output flows through the existing ScriptsEvent channel
// (started/data/exit), which also drives the sidebar activity icon.
export async function runCreateLifecycle(args: CreateArgs): Promise<void> {
  const projectId = args.project.id;
  const worktreeId = args.worktree.id;
  try {
    if (args.carryOverEntries.length > 0) {
      emitPhase(args.webContents, {
        projectId,
        worktreeId,
        phase: "carryOver",
      });
      const report: CarryOverReport = await applyCarryOver(
        args.primaryWorktreePath,
        args.worktree.path,
        args.carryOverEntries,
      );
      emitCarryOverComplete(args.webContents, {
        projectId,
        worktreeId,
        report,
      });
    }

    const defaultBranch = await resolveDefaultBranch(
      args.project.path,
      args.config?.defaultBranch,
    ).catch(() => "");

    const setupCommand = resolveScriptCommand(
      "setup",
      args.config,
      args.worktree.path,
    );
    if (setupCommand) {
      emitPhase(args.webContents, { projectId, worktreeId, phase: "setup" });
      await runStep({
        command: setupCommand,
        scriptName: "setup",
        slot: { kind: "setup" },
        worktree: args.worktree,
        project: args.project,
        projectBranch: args.projectBranch,
        defaultBranch,
        webContents: args.webContents,
      });
    }

    if (args.globalPortPoolEnabled) {
      const [installed, hasConfig] = await Promise.all([
        isPortPoolInstalled(),
        isPortPoolConfigured(args.worktree.path),
      ]);
      if (installed && hasConfig) {
        emitPhase(args.webContents, {
          projectId,
          worktreeId,
          phase: "portPoolProvision",
        });
        await runStep({
          command: resolveScriptCommand(
            "port-pool-provision",
            args.config,
            args.worktree.path,
          ),
          scriptName: "port-pool-provision",
          slot: { kind: "portPool", phase: "provision" },
          worktree: args.worktree,
          project: args.project,
          projectBranch: args.projectBranch,
          defaultBranch,
          webContents: args.webContents,
        });
      }
    }
  } finally {
    emitPhase(args.webContents, { projectId, worktreeId, phase: "idle" });
  }
}

interface DeleteArgs {
  project: LifecycleProject;
  worktree: LifecycleWorktree;
  projectBranch: string;
  config: ShigomoriConfig | null;
  globalPortPoolEnabled: boolean;
  webContents: WebContents;
}

export async function runDeleteCleanup(args: DeleteArgs): Promise<void> {
  markDeleteInflight(args.worktree.id);
  try {
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
          webContents: args.webContents,
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
        webContents: args.webContents,
      });
      if (exitCode !== 0) {
        throw cleanupError("teardown", exitCode, runId);
      }
    }
  } finally {
    clearDeleteInflight(args.worktree.id);
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
