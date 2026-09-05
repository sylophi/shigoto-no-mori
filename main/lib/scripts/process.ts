// POSIX script processes: login-shell spawning under a pseudo-terminal
// and process-group signaling.
//
// Scripts run in a PTY (node-pty) rather than on pipes, so the console
// behaves like a terminal: programs see a TTY, get a real window size,
// emit color without coaxing, and can read keystrokes the renderer
// forwards (interactive prompts, vite's "r"/"q" shortcuts, TUIs).
//
// Kill strategy:
//   1. SIGTERM the process group (negative pgid) -- covers normal forks.
//   2. Walk `ps` for any descendant still reachable via ppid (e.g.
//      double-forked daemons) and SIGTERM those too.
//   3. The caller escalates to SIGKILL through the same path after its
//      grace period.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { type IPty, spawn as spawnPty } from "node-pty";

const execFileP = promisify(execFile);

export type ScriptPty = IPty;

interface SpawnScriptOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

// $SHELL is reliable when launched from a terminal, but can be empty in
// GUI launches depending on launchd state. os.userInfo().shell reads the
// passwd entry directly. We use a *login* shell (no `-i`) so the user's
// `.zprofile` / `.bash_profile` runs without zsh's interactive-init code
// (job control, prompt setup, zle) getting in the way of the command.
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

// Throws synchronously when no process could be started (missing shell
// binary, PTY allocation failure); callers report that as a failed run.
// The PTY child runs in its own session, so its pgid === pid and the
// whole tree can be signaled via process.kill(-pid, sig).
export function spawnScript(opts: SpawnScriptOptions): ScriptPty {
  const { command: shellCmd, args: shellArgs } = resolveShell();
  // node-pty's env is a plain string map; drop the undefined entries
  // NodeJS.ProcessEnv allows.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (value !== undefined) env[key] = value;
  }
  return spawnPty(shellCmd, [...shellArgs, opts.command], {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env,
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
