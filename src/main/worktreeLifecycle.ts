// Main-process orchestration of worktree create/delete lifecycles.
// Owns the sequencing of setup -> port-pool provision (on create) and
// port-pool release -> teardown (on delete), so a closed renderer
// can't leave a worktree half-torn-down. Live output keeps flowing
// to the renderer via "started" events emitted by startScript.
import type { WebContents } from "electron";
import type {
  CleanupError,
  ScriptFailure,
  ShigomoriConfig,
} from "@shared/schemas";
import { resolveDefaultBranch } from "./git";
import { isPortPoolConfigured, isPortPoolInstalled } from "./portPool";
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
  globalPortPoolEnabled: boolean;
  webContents: WebContents;
}

export async function runCreateLifecycle(
  args: CreateArgs,
): Promise<ScriptFailure[]> {
  const failures: ScriptFailure[] = [];
  const defaultBranch = await resolveDefaultBranch(
    args.project.path,
    args.config?.defaultBranch,
  ).catch(() => "");

  const setupCommand = args.config?.scripts?.setup?.trim();
  if (setupCommand) {
    const { runId, exit } = startScriptForLifecycle({
      command: setupCommand,
      scriptName: "setup",
      worktree: args.worktree,
      project: args.project,
      projectBranch: args.projectBranch,
      defaultBranch,
      webContents: args.webContents,
      startedSlot: { kind: "setup" },
      startedProjectId: args.project.id,
      startedWorktreeId: args.worktree.id,
    });
    const code = await exit;
    if (code !== 0) {
      failures.push({ phase: "setup", exitCode: code, runId });
    }
  }

  if (args.globalPortPoolEnabled && (await isPortPoolInstalled())) {
    const hasConfig = await isPortPoolConfigured(args.worktree.path);
    if (hasConfig) {
      const { runId, exit } = startScriptForLifecycle({
        command: `port-pool provision ${shellQuote(args.worktree.path)}`,
        scriptName: "port-pool-provision",
        worktree: args.worktree,
        project: args.project,
        projectBranch: args.projectBranch,
        defaultBranch,
        webContents: args.webContents,
        startedSlot: { kind: "portPool", phase: "provision" },
        startedProjectId: args.project.id,
        startedWorktreeId: args.worktree.id,
      });
      const code = await exit;
      if (code !== 0) {
        failures.push({ phase: "portPoolProvision", exitCode: code, runId });
      }
    }
  }

  return failures;
}

interface DeleteArgs {
  project: LifecycleProject;
  worktree: LifecycleWorktree;
  projectBranch: string;
  config: ShigomoriConfig | null;
  globalPortPoolEnabled: boolean;
  skipCleanup: boolean;
  webContents: WebContents;
}

export async function runDeleteCleanup(args: DeleteArgs): Promise<void> {
  if (args.skipCleanup) return;
  markDeleteInflight(args.worktree.id);
  try {
    const defaultBranch = await resolveDefaultBranch(
      args.project.path,
      args.config?.defaultBranch,
    ).catch(() => "");

    if (args.globalPortPoolEnabled && (await isPortPoolInstalled())) {
      const hasConfig = await isPortPoolConfigured(args.worktree.path);
      if (hasConfig) {
        const { runId, exit } = startScriptForLifecycle({
          command: `port-pool release ${shellQuote(args.worktree.path)}`,
          scriptName: "port-pool-release",
          worktree: args.worktree,
          project: args.project,
          projectBranch: args.projectBranch,
          defaultBranch,
          webContents: args.webContents,
          startedSlot: { kind: "portPool", phase: "release" },
          startedProjectId: args.project.id,
          startedWorktreeId: args.worktree.id,
        });
        const code = await exit;
        if (code !== 0) {
          throw cleanupError("portPoolRelease", code, runId);
        }
      }
    }

    const teardownCommand = args.config?.scripts?.teardown?.trim();
    if (teardownCommand) {
      const { runId, exit } = startScriptForLifecycle({
        command: teardownCommand,
        scriptName: "teardown",
        worktree: args.worktree,
        project: args.project,
        projectBranch: args.projectBranch,
        defaultBranch,
        webContents: args.webContents,
        startedSlot: { kind: "teardown" },
        startedProjectId: args.project.id,
        startedWorktreeId: args.worktree.id,
      });
      const code = await exit;
      if (code !== 0) {
        throw cleanupError("teardown", code, runId);
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
