// POSIX script processes: login-shell spawning and process-group
// signaling.
//
// Kill strategy:
//   1. SIGTERM the process group (negative pgid) -- covers normal forks.
//   2. Walk `ps` for any descendant still reachable via ppid (e.g.
//      double-forked daemons) and SIGTERM those too.
//   3. The caller escalates to SIGKILL through the same path after its
//      grace period.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import {
  SCRIPT_STDIO,
  type ScriptPlatform,
  type SpawnScriptOptions,
} from "./types";

const execFileP = promisify(execFile);

// $SHELL is reliable when launched from a terminal, but can be empty in
// GUI launches depending on launchd state. os.userInfo().shell reads the
// passwd entry directly. We use a *login* shell (no `-i`) so the user's
// `.zprofile` / `.bash_profile` runs without zsh's interactive-init code
// (job control, gitstatus, prompt setup) throwing errors at us when
// there's no controlling TTY.
function resolveShell(): { command: string; args: string[] } {
  const fromEnv = process.env["SHELL"];
  if (fromEnv) return { command: fromEnv, args: ["-l", "-c"] };
  const fromPasswd = userInfo().shell;
  if (fromPasswd) return { command: fromPasswd, args: ["-l", "-c"] };
  return { command: "/bin/sh", args: ["-c"] };
}

function spawnScript(opts: SpawnScriptOptions): ChildProcess {
  const { command: shellCmd, args: shellArgs } = resolveShell();
  return spawn(shellCmd, [...shellArgs, opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: SCRIPT_STDIO,
    // New session = new process group with pgid === child.pid. Lets us
    // signal the whole tree via process.kill(-pid, sig).
    detached: true,
  });
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH (no such process) is the common case once the tree is down.
    // EPERM means we lost ownership; nothing we can do either way.
  }
}

// Walks `ps` to find every process that descends from rootPid via the
// ppid chain. Catches grandchildren that called setsid() and left our
// process group -- still reachable here as long as their ppid hasn't
// been re-parented to init.
async function listDescendantPids(rootPid: number): Promise<number[]> {
  let stdout: string;
  try {
    const result = await execFileP("ps", ["-A", "-o", "pid=,ppid="]);
    stdout = result.stdout;
  } catch {
    return [];
  }
  const byParent = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (pid === rootPid) continue;
    const bucket = byParent.get(ppid);
    if (bucket) bucket.push(pid);
    else byParent.set(ppid, [pid]);
  }
  const out: number[] = [];
  const stack: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const kids = byParent.get(cur);
    if (!kids) continue;
    for (const k of kids) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

async function signalTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  safeKill(-pid, signal);
  const descendants = await listDescendantPids(pid);
  for (const d of descendants) safeKill(d, signal);
}

// Descendants that escaped the group via setsid() get reparented to
// launchd, same as if we hadn't signaled at all.
function signalTreeBestEffort(pid: number, signal: NodeJS.Signals): void {
  safeKill(-pid, signal);
}

export const darwinScriptPlatform: ScriptPlatform = {
  spawnScript,
  signalTree,
  signalTreeBestEffort,
};
