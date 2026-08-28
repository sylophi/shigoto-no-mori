// POSIX script processes: login-shell spawning and process-group
// signaling.
//
// Kill strategy:
//   1. SIGTERM the process group (negative pgid) -- covers normal forks.
//   2. Walk `ps` for any descendant still reachable via ppid (e.g.
//      double-forked daemons) and SIGTERM those too.
//   3. The caller escalates to SIGKILL through the same path after its
//      grace period.
import {
  type ChildProcess,
  execFile,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

interface SpawnScriptOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

// stdin is a pipe we never write to or close. Closed stdin (EOF on first
// read) makes tools like electron-forge and vite that listen for
// keystrokes ("rs", "q") interpret it as "user closed the terminal" and
// shut down, dragging the dev server with them.
const SCRIPT_STDIO: StdioOptions = ["pipe", "pipe", "pipe"];

// $SHELL is reliable when launched from a terminal, but can be empty in
// GUI launches depending on launchd state. os.userInfo().shell reads the
// passwd entry directly. We use a *login* shell (no `-i`) so the user's
// `.zprofile` / `.bash_profile` runs without zsh's interactive-init code
// (job control, gitstatus, prompt setup) throwing errors at us when
// there's no controlling TTY.
function resolveShell(): { command: string; args: string[] } {
  const userShell = process.env["SHELL"] || userInfo().shell;
  if (userShell) return { command: userShell, args: ["-l", "-c"] };
  return { command: "/bin/sh", args: ["-c"] };
}

// Quote one argument for the shell spawnScript launches (POSIX sh
// single-quoting).
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function spawnScript(opts: SpawnScriptOptions): ChildProcess {
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
  // kill(-1) signals every process the user may signal, kill(0) our
  // own group, kill(1) launchd. No real child or group ever maps to
  // these, so refuse them at the chokepoint every pid source funnels
  // through -- the persisted-scripts schema rejects pid < 2 too, but
  // a floor here covers future sources as well.
  if (!Number.isInteger(pid) || Math.abs(pid) < 2) return;
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

// Callers escalate SIGTERM -> grace -> SIGKILL through this same path.
export async function signalTree(
  pid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  safeKill(-pid, signal);
  const descendants = await listDescendantPids(pid);
  for (const d of descendants) safeKill(d, signal);
}

// SIGTERM one direct child, escalating to SIGKILL after graceMs unless
// it exits first. For plain (non-detached) children whose whole work is
// the one process (the cloudflared connector), where the process-group
// walk above would be overkill. The grace timer is unref'd so a pending
// escalation never holds the app open at quit.
export function killWithGrace(child: ChildProcess, graceMs: number): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, graceMs);
  killTimer.unref?.();
  child.once("exit", () => clearTimeout(killTimer));
}

// Synchronous fire-and-forget variant for the update-install quit path,
// where awaiting the kill chain would block the updater's handoff.
// Descendants that escaped the group via setsid() get reparented to
// launchd, same as if we hadn't signaled at all.
export function signalTreeBestEffort(
  pid: number,
  signal: NodeJS.Signals,
): void {
  safeKill(-pid, signal);
}
