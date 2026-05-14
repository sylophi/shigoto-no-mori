// Spawn per-project setup/teardown scripts with streamed stdout/stderr
// events sent back to the originating renderer.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import type { WebContents } from "electron";
import { CHANNELS } from "@shared/channels";
import type { ScriptEvent, ScriptName } from "@shared/schemas";

const runningScripts = new Map<string, ChildProcess>();

interface RunArgs {
  command: string;
  cwd: string;
  scriptName: ScriptName;
  worktreeId: string;
  worktreeName: string;
  worktreeBranch: string;
  projectPath: string;
  projectName: string;
  projectBranch: string;
  defaultBranch: string;
  webContents: WebContents;
}

function emit(webContents: WebContents, payload: ScriptEvent): void {
  if (webContents.isDestroyed()) return;
  webContents.send(CHANNELS.ScriptsEvent, payload);
}

// Run the user's preferred shell as login+interactive so .zprofile *and*
// .zshrc (or bash equivalents) are sourced. Without this, tools that
// users add to PATH via nvm / pyenv / asdf / brew-shellenv inside .zshrc
// aren't available to scripts.
//
// Shell discovery: $SHELL is reliable when launched from a terminal, but
// can be empty in GUI launches (Finder/Dock/Spotlight) depending on
// launchd state. os.userInfo().shell reads the user's passwd entry
// directly, which works regardless of how the app was started.
function resolveShell(): { command: string; args: string[] } {
  const fromEnv = process.env["SHELL"];
  if (fromEnv) return { command: fromEnv, args: ["-l", "-i", "-c"] };
  const fromPasswd = userInfo().shell;
  if (fromPasswd) return { command: fromPasswd, args: ["-l", "-i", "-c"] };
  return { command: "/bin/sh", args: ["-c"] };
}

export function startScript(args: RunArgs): string {
  const runId = randomUUID();
  const env = {
    ...process.env,
    SHIGOMORI_SCRIPT_NAME: args.scriptName,
    SHIGOMORI_WORKTREE_PATH: args.cwd,
    SHIGOMORI_WORKTREE_NAME: args.worktreeName,
    SHIGOMORI_WORKTREE_BRANCH: args.worktreeBranch,
    SHIGOMORI_WORKTREE_ID: args.worktreeId,
    SHIGOMORI_PROJECT_PATH: args.projectPath,
    SHIGOMORI_PROJECT_NAME: args.projectName,
    SHIGOMORI_PROJECT_BRANCH: args.projectBranch,
    SHIGOMORI_DEFAULT_BRANCH: args.defaultBranch,
  };

  const { command: shellCmd, args: shellArgs } = resolveShell();
  const child = spawn(shellCmd, [...shellArgs, args.command], {
    cwd: args.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  runningScripts.set(runId, child);

  child.stdout?.on("data", (chunk: Buffer) => {
    emit(args.webContents, {
      runId,
      kind: "stdout",
      data: chunk.toString("utf8"),
    });
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    emit(args.webContents, {
      runId,
      kind: "stderr",
      data: chunk.toString("utf8"),
    });
  });

  child.on("error", (error) => {
    emit(args.webContents, {
      runId,
      kind: "error",
      data: error.message,
    });
    runningScripts.delete(runId);
  });

  child.on("exit", (code) => {
    emit(args.webContents, { runId, kind: "exit", code });
    runningScripts.delete(runId);
  });

  return runId;
}

export function cancelScript(runId: string): boolean {
  const child = runningScripts.get(runId);
  if (!child) return false;
  child.kill("SIGTERM");
  // Hard kill if SIGTERM doesn't take effect.
  const timer = setTimeout(() => {
    if (runningScripts.has(runId)) child.kill("SIGKILL");
  }, 3_000);
  child.once("exit", () => clearTimeout(timer));
  return true;
}
