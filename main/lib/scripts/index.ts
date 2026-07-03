// Spawn per-project setup/teardown and package scripts and stream their
// merged stdout+stderr to the renderer. Each script runs in its own
// session so we can kill the entire tree of children (dev servers,
// watchers, compilers the user's command spawns), not just the
// wrapping shell.
//
// Kill strategy (POSIX):
//   1. SIGTERM the process group (negative pgid) -- covers normal forks.
//   2. Walk `ps` for any descendant still reachable via ppid (e.g.
//      double-forked daemons) and SIGTERM those too.
//   3. After a grace period, SIGKILL anything still alive in either set.
//
// Kill strategy (Windows): POSIX signals and process groups don't exist,
// and console processes have no graceful-kill channel (taskkill without
// /F sends WM_CLOSE, which they ignore), so we go straight to
// `taskkill /T /F` -- a forced kill of the whole tree.
//
// On app quit (see index.ts) we kill every running script the same way
// before letting Electron exit, so a Cmd-Q never orphans `npm run dev`.
import {
  type ChildProcess,
  execFile,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { Project, ScriptEvent } from "@shared/schemas";
import { SCRIPT_ENV_KEYS } from "@shared/scriptEnv";
import { isWindows } from "../util/platform";

// Renderer-facing emit callback supplied by the IPC handler. Lets the
// scripts layer stay Electron-free while still streaming events to the
// caller's window.
export type NotifyScriptEvent = (payload: ScriptEvent) => void;

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
  scriptName: string;
  worktree: ScriptWorktree;
  project: Pick<Project, "id" | "path" | "name">;
  projectBranch: string;
  defaultBranch: string;
  notify: NotifyScriptEvent;
  // When set, main is the initiator (lifecycle orchestration) and
  // we emit a "started" event so the renderer binds runId to slot.
  // Omit for renderer-driven runs -- the renderer already knows the
  // slot from scriptRuns.start().
  started?: {
    slot:
      | { kind: "setup" }
      | { kind: "teardown" }
      | { kind: "portPool"; phase: "provision" | "release" };
    projectId: string;
    worktreeId: string;
  };
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
  done: Promise<void>;
  notify: NotifyScriptEvent;
}

const runningScripts = new Map<string, RunRecord>();
const exitObservers = new Map<string, (code: number | null) => void>();
const inflightDeleteIds = new Set<string>();
let shuttingDown = false;

// Resolves the lifecycle observer registered by startScriptForLifecycle,
// at most once per run. Every end-of-run path (spawn failure, child
// "error", exit) funnels through here so none of them can leak or
// double-resolve the observer.
function resolveExitObserver(runId: string, code: number | null): void {
  const observer = exitObservers.get(runId);
  if (!observer) return;
  exitObservers.delete(runId);
  observer(code);
}

export function markDeleteInflight(worktreeId: string): void {
  inflightDeleteIds.add(worktreeId);
}

export function clearDeleteInflight(worktreeId: string): void {
  inflightDeleteIds.delete(worktreeId);
}

export function getInflightDeleteIds(): ReadonlySet<string> {
  return inflightDeleteIds;
}

export interface BusyOperations {
  runningScripts: number;
  inflightDeletes: number;
}

// Lifecycle scripts (setup, teardown, port-pool) all spawn through
// startScript, so runningScripts covers package scripts plus the
// create/delete lifecycles in a single count.
export function getBusyOperations(): BusyOperations {
  return {
    runningScripts: runningScripts.size,
    inflightDeletes: inflightDeleteIds.size,
  };
}

export function markShuttingDown(): void {
  shuttingDown = true;
}

// POSIX shell resolution; Windows runs go through `shell: true` instead
// (see startScript), which picks %ComSpec% and handles cmd.exe's quote
// rules itself. $SHELL is reliable when launched from a terminal, but
// can be empty in GUI launches depending on launchd state.
// os.userInfo().shell reads the passwd entry directly. We use a *login*
// shell (no `-i`) so the user's `.zprofile` / `.bash_profile` runs
// without zsh's interactive-init code (job control, gitstatus, prompt
// setup) throwing errors at us when there's no controlling TTY.
function resolveShell(): { command: string; args: string[] } {
  const fromEnv = process.env["SHELL"];
  if (fromEnv) return { command: fromEnv, args: ["-l", "-c"] };
  const fromPasswd = userInfo().shell;
  if (fromPasswd) return { command: fromPasswd, args: ["-l", "-c"] };
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

// Windows tree kill. `/T` makes taskkill walk the child tree itself, so
// no separate descendant walk is needed. Always `/F`: the polite
// non-forced mode sends WM_CLOSE, which console processes (everything a
// script spawns) ignore, so a "graceful" first pass would only burn the
// grace period before the forced pass lands anyway. Windows has no
// SIGTERM equivalent for console trees; forced kill is the native
// behavior.
async function taskkillTree(pid: number): Promise<void> {
  try {
    await execFileP("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
  } catch {
    // Nonzero exit: tree already gone, or we lost ownership.
  }
}

async function signalTree(
  record: RunRecord,
  signal: NodeJS.Signals,
): Promise<void> {
  if (isWindows) {
    // Both kill stages force-kill; the second pass is a no-op backstop.
    await taskkillTree(record.pid);
    return;
  }
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
    record.notify({
      runId: record.runId,
      kind: "data",
      data: `\r\n\x1b[2m[${opts.reason}]\x1b[0m\r\n`,
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

  if (args.started) {
    args.notify({
      runId,
      kind: "started",
      projectId: args.started.projectId,
      worktreeId: args.started.worktreeId,
      slot: args.started.slot,
    });
  }

  const env = {
    ...process.env,
    // Convince modern tools (npm, pnpm, bun, vite, vitest, tsc, eslint
    // …) to emit ANSI even though stdout isn't a TTY. xterm in the
    // renderer interprets the codes.
    FORCE_COLOR: "1",
    TERM: "xterm-256color",
    // Give programs that auto-format to terminal width a reasonable
    // default rather than the conventional 80-col fallback.
    COLUMNS: "120",
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

  // Shared spawn options. stdin is a pipe we never write to or close:
  // closed stdin (EOF on first read) makes tools like electron-forge and
  // vite that listen for keystrokes ("rs", "q") interpret it as "user
  // closed the terminal" and shut down, dragging the dev server with
  // them.
  const spawnBase = {
    cwd: args.worktree.path,
    env,
    stdio: ["pipe", "pipe", "pipe"] satisfies StdioOptions,
  };
  // Windows: `shell: true` runs the command through %ComSpec% (cmd.exe)
  // with Node handling cmd's quote rules; hand-assembling the /d /s /c
  // argument list mangles commands with quoted paths. No `detached`:
  // there are no POSIX process groups to claim -- taskkill /T walks the
  // tree by parent pid -- and detaching would only spawn a stray console.
  //
  // POSIX: login shell wrapping via resolveShell, and `detached` so the
  // new session's pgid === child.pid, which lets the kill path signal the
  // whole tree via process.kill(-pid, sig).
  let child: ChildProcess;
  if (isWindows) {
    child = spawn(args.command, [], {
      ...spawnBase,
      shell: true,
      windowsHide: true,
    });
  } else {
    const { command: shellCmd, args: shellArgs } = resolveShell();
    child = spawn(shellCmd, [...shellArgs, args.command], {
      ...spawnBase,
      detached: true,
    });
  }

  if (!child.pid) {
    // spawn failed before a process existed (missing shell binary,
    // deleted cwd). Node reports the cause via an async "error" event;
    // with no listener attached that emit rethrows as an uncaught
    // exception and crashes the main process. The microtask fallback
    // covers any path where the event never fires, and both run after
    // startScriptForLifecycle has registered its exit observer.
    let reported = false;
    const reportSpawnFailure = (message: string) => {
      if (reported) return;
      reported = true;
      args.notify({ runId, kind: "error", data: message });
      args.notify({ runId, kind: "exit", code: null });
      resolveExitObserver(runId, null);
    };
    child.once("error", (error) => reportSpawnFailure(error.message));
    queueMicrotask(() => reportSpawnFailure("Failed to start script process"));
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
    notify: args.notify,
  };
  runningScripts.set(runId, record);

  // Shared end-of-run bookkeeping. The renderer-facing event differs per
  // path ("error" vs "exit"), so callers emit that first, then settle.
  // Idempotent: a child "error" followed by "close" settles twice, and
  // the second call finds everything already done.
  const settle = (observedCode: number | null) => {
    resolveExitObserver(runId, observedCode);
    record.exited = true;
    resolveDone();
    runningScripts.delete(runId);
  };

  // Both streams flow into a single "data" event so xterm sees one
  // ordered byte stream (matches how a real terminal would render it).
  child.stdout?.on("data", (chunk: Buffer) => {
    args.notify({
      runId,
      kind: "data",
      data: chunk.toString("utf8"),
    });
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    args.notify({
      runId,
      kind: "data",
      data: chunk.toString("utf8"),
    });
  });

  child.on("error", (error) => {
    args.notify({ runId, kind: "error", data: error.message });
    settle(null);
  });

  let exitNotified = false;
  let flushTimer: NodeJS.Timeout | null = null;
  const finalizeExit = (code: number | null, signal: string | null) => {
    if (exitNotified) return;
    exitNotified = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // SIGTERM via our kill path commonly surfaces as exit 143 (128+15)
    // because the shell wrapping the user's command translated the
    // signal into an exit code. If we initiated the cancel, report
    // null code so the UI shows "stopped" not "failed".
    const wasSignal = signal !== null;
    const reported = record.cancelling || wasSignal ? null : code;
    args.notify({ runId, kind: "exit", code: reported });
    settle(reported);
  };

  // Notify exit on "close" (process ended AND stdio flushed), not "exit":
  // the pipes routinely still hold the run's last chunks at "exit", and
  // the renderer unbinds the runId once it sees the exit event -- a
  // fast-failing script would lose its final error output. The timer
  // fallback keeps a backgrounded grandchild that inherited the pipes
  // from wedging the run (and the kill/lifecycle chains awaiting `done`).
  child.on("exit", (code, signal) => {
    flushTimer = setTimeout(() => finalizeExit(code, signal), 500);
  });
  child.on("close", (code, signal) => {
    finalizeExit(code, signal);
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
    targets.map((r) => killRecord(r, { reason: "Worktree removed", ...opts })),
  );
}

export async function killAllScripts(opts: KillOptions = {}): Promise<void> {
  const targets = Array.from(runningScripts.values()).filter((r) => !r.exited);
  if (targets.length === 0) return;
  await Promise.all(
    targets.map((r) => killRecord(r, { reason: "App quit", ...opts })),
  );
}

// Synchronous best-effort SIGTERM to every running script's process
// group. Used by the update-install quit path, where we can't await
// the full kill chain (that would block Squirrel's ShipIt handoff) but
// still want well-behaved scripts to clean up gracefully before
// Electron tears the main process down. Descendants that escaped the
// group via setsid() get reparented to launchd, same as if we hadn't
// signaled at all. On Windows this fires taskkill /T /F without
// awaiting it: there is no graceful signal to send, and the force kill
// races the process exit the same way the POSIX SIGTERM does.
export function signalAllScriptsBestEffort(signal: NodeJS.Signals): void {
  for (const record of runningScripts.values()) {
    if (record.exited) continue;
    if (isWindows) {
      void taskkillTree(record.pid);
      continue;
    }
    safeKill(-record.pid, signal);
  }
}

export function startScriptForLifecycle(args: RunArgs): {
  runId: string;
  exit: Promise<number | null>;
} {
  let resolveExit!: (code: number | null) => void;
  const exit = new Promise<number | null>((res) => {
    resolveExit = res;
  });
  const runId = startScript(args);
  exitObservers.set(runId, resolveExit);
  return { runId, exit };
}
