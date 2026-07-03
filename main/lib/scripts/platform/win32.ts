// Windows script processes: cmd.exe spawning via Node's shell handling
// and forced tree kills.
//
// Kill strategy: POSIX signals and process groups don't exist, and
// console processes have no graceful-kill channel (taskkill without /F
// sends WM_CLOSE, which they ignore), so both signals map to
// `taskkill /T /F` -- a forced kill of the whole tree. The caller's
// SIGKILL escalation after its grace period is then a no-op backstop.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  SCRIPT_STDIO,
  type ScriptPlatform,
  type SpawnScriptOptions,
} from "./types";

const execFileP = promisify(execFile);

function spawnScript(opts: SpawnScriptOptions): ChildProcess {
  // `shell: true` runs the command through %ComSpec% (cmd.exe) with Node
  // handling cmd's quote rules; hand-assembling the /d /s /c argument
  // list mangles commands with quoted paths. No `detached`: there are no
  // POSIX process groups to claim -- taskkill /T walks the tree by
  // parent pid -- and detaching would only spawn a stray console.
  return spawn(opts.command, [], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: SCRIPT_STDIO,
    shell: true,
    windowsHide: true,
  });
}

// `/T` makes taskkill walk the child tree itself, so no separate
// descendant walk is needed.
async function taskkillTree(pid: number): Promise<void> {
  try {
    await execFileP("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
  } catch {
    // Nonzero exit: tree already gone, or we lost ownership.
  }
}

async function signalTree(pid: number): Promise<void> {
  await taskkillTree(pid);
}

// Detached + unref: the quit path returns immediately after calling
// this and Electron tears the process down. A detached taskkill escapes
// the parent's teardown (it isn't tied to our process's lifetime) and
// finishes walking the tree on its own, without ever blocking the
// Squirrel handoff the caller is racing toward.
function signalTreeBestEffort(pid: number): void {
  try {
    const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best effort; nothing to do if taskkill can't start.
  }
}

export const win32ScriptPlatform: ScriptPlatform = {
  spawnScript,
  signalTree,
  signalTreeBestEffort,
};
