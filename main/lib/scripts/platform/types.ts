// Shared shapes for the per-platform script process implementations
// (darwin.ts / win32.ts). Spawning and tree-killing differ wholesale per
// OS; everything else in the scripts layer is platform-free and talks to
// this interface.
import type { ChildProcess, StdioOptions } from "node:child_process";

export interface SpawnScriptOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

// stdin is a pipe we never write to or close. Closed stdin (EOF on first
// read) makes tools like electron-forge and vite that listen for
// keystrokes ("rs", "q") interpret it as "user closed the terminal" and
// shut down, dragging the dev server with them.
export const SCRIPT_STDIO: StdioOptions = ["pipe", "pipe", "pipe"];

export interface ScriptPlatform {
  // Spawn the user's shell command with merged-stream pipes attached.
  spawnScript(opts: SpawnScriptOptions): ChildProcess;
  // Signal the process tree rooted at pid. Callers escalate SIGTERM ->
  // grace -> SIGKILL; platforms without a graceful channel may treat
  // both signals as forced.
  signalTree(pid: number, signal: NodeJS.Signals): Promise<void>;
  // Synchronous fire-and-forget variant for the update-install quit
  // path, where awaiting the kill chain would block Squirrel's handoff.
  signalTreeBestEffort(pid: number, signal: NodeJS.Signals): void;
}
