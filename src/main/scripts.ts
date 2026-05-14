// Spawn per-project setup/teardown scripts with streamed stdout/stderr
// events sent back to the originating renderer.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import type { WebContents } from "electron";
import { CHANNELS } from "@shared/channels";
import type { Project, ScriptEvent } from "@shared/schemas";
import { SCRIPT_ENV_KEYS } from "@shared/scriptEnv";

const runningScripts = new Map<string, ChildProcess>();

// Slim view of a worktree identity for script env injection — keeps the
// signature pinned to the few fields scripts actually consume.
interface ScriptWorktree {
  id: string;
  name: string;
  branch: string;
  path: string;
}

interface RunArgs {
  command: string;
  // Configured setup/teardown pass "setup"/"teardown"; package scripts
  // pass the actual script name ("dev", "build", etc.). Stored verbatim
  // into SHIGOMORI_SCRIPT_NAME for the script to read.
  scriptName: string;
  worktree: ScriptWorktree;
  project: Pick<Project, "path" | "name">;
  projectBranch: string;
  defaultBranch: string;
  webContents: WebContents;
}

function emit(webContents: WebContents, payload: ScriptEvent): void {
  if (webContents.isDestroyed()) return;
  webContents.send(CHANNELS.ScriptsEvent, payload);
}

// $SHELL is reliable when launched from a terminal, but can be empty in
// GUI launches depending on launchd state. os.userInfo().shell reads the
// passwd entry directly. Flags `-l -i -c` source both .zprofile and
// .zshrc (or bash equivalents) so tools users added to PATH via nvm /
// pyenv / brew-shellenv inside their rc are available to the script.
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
    [SCRIPT_ENV_KEYS.SCRIPT_NAME]: args.scriptName,
    [SCRIPT_ENV_KEYS.WORKTREE_PATH]: args.worktree.path,
    [SCRIPT_ENV_KEYS.WORKTREE_NAME]: args.worktree.name,
    [SCRIPT_ENV_KEYS.WORKTREE_BRANCH]: args.worktree.branch,
    [SCRIPT_ENV_KEYS.WORKTREE_ID]: args.worktree.id,
    [SCRIPT_ENV_KEYS.PROJECT_PATH]: args.project.path,
    [SCRIPT_ENV_KEYS.PROJECT_NAME]: args.project.name,
    [SCRIPT_ENV_KEYS.PROJECT_BRANCH]: args.projectBranch,
    [SCRIPT_ENV_KEYS.DEFAULT_BRANCH]: args.defaultBranch,
  };

  const { command: shellCmd, args: shellArgs } = resolveShell();
  const child = spawn(shellCmd, [...shellArgs, args.command], {
    cwd: args.worktree.path,
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
