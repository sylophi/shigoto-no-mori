// Spawn per-project setup/teardown and package scripts and stream their
// merged stdout+stderr to the renderer. Each script runs in its own
// session so we can kill the entire tree of children (dev servers,
// watchers, compilers the user's command spawns), not just the
// wrapping shell.
//
// The OS-specific mechanics (which shell wraps the command, how a
// process tree is signaled) live in ./platform -- this file only runs
// the SIGTERM -> grace -> SIGKILL escalation over that interface.
//
// On app quit (see index.ts) we kill every running script the same way
// before letting Electron exit, so a Cmd-Q never orphans `npm run dev`.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Project, ScriptEvent } from "@shared/schemas";
import { SCRIPT_ENV_KEYS } from "@shared/scriptEnv";
import { scriptPlatform } from "./platform";

// Renderer-facing emit callback supplied by the IPC handler. Lets the
// scripts layer stay Electron-free while still streaming events to the
// caller's window.
export type NotifyScriptEvent = (payload: ScriptEvent) => void;

const DEFAULT_GRACE_MS = 3_000;
// How long to wait for a child that survived SIGKILL / taskkill -F
// (kernel-stuck I/O, taskkill unavailable) before giving up. Callers
// (worktree delete, app quit) must not hang forever behind it.
const UNKILLABLE_WAIT_MS = 5_000;

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
// Ref-counted: overlapping deleters can mark the same worktree (a
// per-worktree delete racing a nuke that lists it too), and the guard
// must hold until the LAST one finishes -- with a plain Set, whichever
// finally ran first would drop the other's still-needed mark.
const inflightDeleteCounts = new Map<string, number>();
const inflightProjectDeleteIds = new Set<string>();
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
  inflightDeleteCounts.set(
    worktreeId,
    (inflightDeleteCounts.get(worktreeId) ?? 0) + 1,
  );
}

export function clearDeleteInflight(worktreeId: string): void {
  const count = inflightDeleteCounts.get(worktreeId);
  if (count === undefined) return;
  if (count <= 1) inflightDeleteCounts.delete(worktreeId);
  else inflightDeleteCounts.set(worktreeId, count - 1);
}

export function getInflightDeleteIds(): ReadonlySet<string> {
  return new Set(inflightDeleteCounts.keys());
}

// Project-level counterpart for projects.remove, which doesn't know its
// worktree ids without a git call: blocks new renderer script runs
// anywhere in the project while its scripts are being reaped and the
// registry entry is dropped.
export function markProjectDeleteInflight(projectId: string): void {
  inflightProjectDeleteIds.add(projectId);
}

export function clearProjectDeleteInflight(projectId: string): void {
  inflightProjectDeleteIds.delete(projectId);
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
    inflightDeletes: inflightDeleteCounts.size + inflightProjectDeleteIds.size,
  };
}

export function markShuttingDown(): void {
  shuttingDown = true;
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

// The OS frees the child's pid at its "exit" event, but record.exited
// only flips once stdio flushes ("close", or "exit" + 500ms when a
// grandchild inherited the pipes). Killing by pid inside that gap can
// hit a recycled pid -- on Windows, taskkill /T would then take down an
// unrelated process and its whole descendant tree. A dead root is also
// useless as a kill target (the tree walks need it alive), so every
// kill path treats it as already exited.
function rootPidDead(record: RunRecord): boolean {
  return record.child.exitCode !== null || record.child.signalCode !== null;
}

async function killRecord(record: RunRecord, opts: KillOptions): Promise<void> {
  if (record.exited) return;
  if (record.cancelling) {
    // Another caller is already escalating; wait for it, but bounded --
    // an unkillable child must not wedge this caller's chain too.
    await waitWithTimeout(record.done, DEFAULT_GRACE_MS + UNKILLABLE_WAIT_MS);
    return;
  }
  if (rootPidDead(record)) {
    // Root already exited; only the stdio flush is outstanding (the
    // "exit" handler armed the fallback timer, so `done` resolves within
    // 500ms). Waiting preserves the caller's "nothing running after
    // this" guarantee without ever signaling a possibly-recycled pid.
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

  await scriptPlatform.signalTree(record.pid, "SIGTERM");
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const exited = await waitWithTimeout(record.done, graceMs);
  if (exited) return;

  await scriptPlatform.signalTree(record.pid, "SIGKILL");
  const died = await waitWithTimeout(record.done, UNKILLABLE_WAIT_MS);
  if (!died) {
    // Give up rather than hanging the caller forever. The record stays
    // live on purpose: the process really is still running, so the busy
    // counts stay honest and a later delete attempt can retry.
    console.warn(
      `[scripts] "${record.scriptName}" (pid ${record.pid}) survived SIGKILL; giving up on this kill attempt`,
    );
  }
}

export function startScript(args: RunArgs): string {
  if (shuttingDown) {
    throw new Error("App is shutting down; refusing to start a new script.");
  }
  const cwdIssue = scriptPlatform.unsupportedCwdReason(args.worktree.path);
  if (cwdIssue) {
    throw new Error(cwdIssue);
  }
  // Renderer-driven runs must not land in a worktree that's mid-delete:
  // the delete flow snapshots running scripts once (killScriptsForWorktree),
  // so a spawn slipping in after that leaves a live dev server whose cwd
  // is being rm'd. Lifecycle runs (args.started set) are exempt -- the
  // delete's own teardown executes while the id is flagged.
  if (args.started === undefined) {
    if (inflightDeleteCounts.has(args.worktree.id)) {
      throw new Error("This worktree is being deleted.");
    }
    if (inflightProjectDeleteIds.has(args.project.id)) {
      throw new Error("This project is being removed.");
    }
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

  const child: ChildProcess = scriptPlatform.spawnScript({
    command: args.command,
    cwd: args.worktree.path,
    env,
  });

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

async function killMatching(
  predicate: (record: RunRecord) => boolean,
  reason: string,
  opts: KillOptions,
): Promise<void> {
  const targets = Array.from(runningScripts.values()).filter(
    (r) => !r.exited && predicate(r),
  );
  if (targets.length === 0) return;
  await Promise.all(targets.map((r) => killRecord(r, { reason, ...opts })));
}

export async function killScriptsForWorktree(
  worktreeId: string,
  opts: KillOptions = {},
): Promise<void> {
  await killMatching(
    (r) => r.worktreeId === worktreeId,
    "Worktree removed",
    opts,
  );
}

export async function killScriptsForProject(
  projectId: string,
  opts: KillOptions = {},
): Promise<void> {
  await killMatching((r) => r.projectId === projectId, "Project removed", opts);
}

export async function killAllScripts(opts: KillOptions = {}): Promise<void> {
  await killMatching(() => true, "App quit", opts);
}

// Synchronous best-effort kill for every running script's tree. Used
// by the update-install quit path (macOS-only today), where we can't
// await the full kill chain (that would block the updater's ShipIt
// handoff) but still want well-behaved scripts to clean up before
// Electron tears the main process down. Per-OS semantics live in
// ./platform.
export function signalAllScriptsBestEffort(signal: NodeJS.Signals): void {
  for (const record of runningScripts.values()) {
    if (record.exited || rootPidDead(record)) continue;
    scriptPlatform.signalTreeBestEffort(record.pid, signal);
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
