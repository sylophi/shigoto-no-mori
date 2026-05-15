// Spawn per-project setup/teardown and package scripts with streamed
// stdout/stderr events. Each script runs in its own process group so we
// can stop the entire tree of children (dev servers, watchers, compilers
// the user's command spawns), not just the wrapping shell.
//
// Kill strategy:
//   1. SIGTERM the process group (negative pgid) — covers normal forks.
//   2. Walk `ps` for any descendant that escaped the group (setsid,
//      double-fork daemons) and SIGTERM those too.
//   3. After a grace period, SIGKILL anything still alive in either set.
//
// On app quit (see main.ts) we kill every running script the same way
// before letting Electron exit, so a Cmd-Q never orphans `npm run dev`.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { WebContents } from "electron";
import { CHANNELS } from "@shared/channels";
import type { Project, ScriptEvent } from "@shared/schemas";
import { SCRIPT_ENV_KEYS } from "@shared/scriptEnv";

const execFileP = promisify(execFile);

const DEFAULT_GRACE_MS = 3_000;

interface ScriptWorktree {
  id: string;
  name: string;
  branch: string;
  path: string;
}

interface RunArgs {
  command: string;
  // Configured setup/teardown pass "setup"/"teardown"; package scripts
  // pass the actual script name. Stored verbatim into
  // SHIGOMORI_SCRIPT_NAME for the script to read.
  scriptName: string;
  worktree: ScriptWorktree;
  project: Pick<Project, "id" | "path" | "name">;
  projectBranch: string;
  defaultBranch: string;
  webContents: WebContents;
}

interface RunRecord {
  runId: string;
  pid: number;
  child: ChildProcess;
  projectId: string;
  worktreeId: string;
  scriptName: string;
  startedAt: number;
  exited: boolean;
  cancelling: boolean;
  // Resolves on 'exit' or 'error'. Used by cancel/killAll to await
  // teardown without re-attaching listeners.
  done: Promise<void>;
  webContents: WebContents;
}

const runningScripts = new Map<string, RunRecord>();
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function markShuttingDown(): void {
  shuttingDown = true;
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
// process group — they're still reachable here as long as their ppid
// hasn't been re-parented to init.
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

// Signal the process group first (negative pid targets the whole group),
// then any descendant still reachable via ppid. The order matters: hit
// the in-group processes synchronously before the async ps walk so we
// minimize the window for the user's script to spawn more children.
async function signalTree(record: RunRecord, signal: NodeJS.Signals): Promise<void> {
  safeKill(-record.pid, signal);
  const descendants = await listDescendantPids(record.pid);
  for (const pid of descendants) safeKill(pid, signal);
}

async function waitWithTimeout(
  promise: Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const finished = promise.then(() => true);
  const result = await Promise.race([finished, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

interface KillOptions {
  graceMs?: number;
  reason?: string;
}

async function killRecord(record: RunRecord, opts: KillOptions): Promise<void> {
  if (record.exited) return;
  if (record.cancelling) {
    await record.done;
    return;
  }
  record.cancelling = true;

  if (opts.reason) {
    emit(record.webContents, {
      runId: record.runId,
      kind: "stderr",
      data: `\n— ${opts.reason} —\n`,
    });
  }

  await signalTree(record, "SIGTERM");
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const exited = await waitWithTimeout(record.done, graceMs);
  if (exited) return;

  await signalTree(record, "SIGKILL");
  await record.done;
}

export function startScript(args: RunArgs): string {
  if (shuttingDown) {
    throw new Error("App is shutting down; refusing to start a new script.");
  }

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
    // New session = new process group with pgid === child.pid. Lets us
    // signal the whole tree via process.kill(-pid, sig).
    detached: true,
  });

  // pid is undefined when spawn fails synchronously (rare; usually
  // ENOENT or EACCES). Report and bail.
  if (!child.pid) {
    queueMicrotask(() => {
      emit(args.webContents, {
        runId,
        kind: "error",
        data: "Failed to start script process",
      });
      emit(args.webContents, { runId, kind: "exit", code: null });
    });
    return runId;
  }

  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const record: RunRecord = {
    runId,
    pid: child.pid,
    child,
    projectId: args.project.id,
    worktreeId: args.worktree.id,
    scriptName: args.scriptName,
    startedAt: Date.now(),
    exited: false,
    cancelling: false,
    done,
    webContents: args.webContents,
  };
  runningScripts.set(runId, record);

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
    if (!record.exited) {
      record.exited = true;
      resolveDone();
    }
    runningScripts.delete(runId);
  });

  child.on("exit", (code) => {
    emit(args.webContents, { runId, kind: "exit", code });
    record.exited = true;
    resolveDone();
    runningScripts.delete(runId);
  });

  return runId;
}

export async function cancelScript(
  runId: string,
  opts: KillOptions = {},
): Promise<boolean> {
  const record = runningScripts.get(runId);
  if (!record) return false;
  await killRecord(record, { reason: "Cancelled by user", ...opts });
  return true;
}

export async function killScriptsForWorktree(
  worktreeId: string,
  opts: KillOptions = {},
): Promise<void> {
  const targets = Array.from(runningScripts.values()).filter(
    (r) => r.worktreeId === worktreeId && !r.exited,
  );
  if (targets.length === 0) return;
  await Promise.all(
    targets.map((r) =>
      killRecord(r, { reason: "Worktree removed", ...opts }),
    ),
  );
}

export async function killAllScripts(opts: KillOptions = {}): Promise<void> {
  const targets = Array.from(runningScripts.values()).filter((r) => !r.exited);
  if (targets.length === 0) return;
  await Promise.all(
    targets.map((r) => killRecord(r, { reason: "App quit", ...opts })),
  );
}
