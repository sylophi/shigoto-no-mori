// Spawn shigoto.json scripts (setup/run/teardown) with streamed
// stdout/stderr events sent back to the originating renderer.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { CHANNELS } from "@shared/channels";
import type { ScriptEvent, ScriptName } from "@shared/schemas";

const runningScripts = new Map<string, ChildProcess>();

interface RunArgs {
  command: string;
  cwd: string;
  scriptName: ScriptName;
  worktreeId: string;
  port: number | undefined;
  webContents: WebContents;
}

function emit(webContents: WebContents, payload: ScriptEvent): void {
  if (webContents.isDestroyed()) return;
  webContents.send(CHANNELS.ScriptsEvent, payload);
}

export function startScript(args: RunArgs): string {
  const runId = randomUUID();
  const env = {
    ...process.env,
    SHIGOTO_WORKSPACE_PATH: args.cwd,
    SHIGOTO_PORT: args.port ? String(args.port) : "",
    SHIGOTO_WORKTREE_ID: args.worktreeId,
    SHIGOTO_SCRIPT_NAME: args.scriptName,
  };

  const child = spawn(args.command, [], {
    cwd: args.cwd,
    env,
    shell: true,
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
