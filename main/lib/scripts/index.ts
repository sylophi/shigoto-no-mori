// Spawn per-project scripts under a PTY and stream their terminal
// output to the renderer, which feeds keystrokes and window-size changes
// back through writeToScript / resizeScript. Each script runs in its
// own session so we can kill the entire tree of children (dev servers,
// watchers, compilers the user's command spawns), not just the wrapping
// shell.
//
// The spawn/signal mechanics live in ./process.ts -- this file only
// runs the SIGTERM -> grace -> SIGKILL escalation over them.
//
// On app quit (see index.ts) we kill every running script the same way
// before letting Electron exit, so a Cmd-Q never orphans `npm run dev`.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { errorMessageOf } from "@shared/errors";
import type { Project, ScriptEvent } from "@shared/schemas";
import { SCRIPT_ENV_KEYS } from "@shared/scriptEnv";
import { type PersistedScript, persistRunningScripts } from "./persistence";
import {
  type ScriptPty,
  signalTree,
  signalTreeBestEffort,
  spawnScript,
} from "./process";

// Renderer-facing emit callback supplied by the IPC handler. Lets the
// scripts layer stay Electron-free while still streaming events to the
// caller's window.
export type NotifyScriptEvent = (payload: ScriptEvent) => void;

const DEFAULT_GRACE_MS = 3_000;
// How long to wait for a child that survived SIGKILL (kernel-stuck I/O)
// before giving up. Callers (worktree delete, app quit) must not hang
// forever behind it.
const UNKILLABLE_WAIT_MS = 5_000;
// PTY size a script starts with. The console resizes it to the real
// viewport as soon as it is on screen, but scripts launched from a
// worktree row (or by a lifecycle) may run a while before -- or without
// -- anyone opening the console, so the default should suit a log.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
// PTYs hand output over in many small reads (a TUI redraw is several, a
// keystroke echo is one byte) and each event costs an IPC hop, a schema
// parse and a render, so reads that land within a frame go out as one
// chunk. The byte ceiling keeps a firehose from pooling for the whole
// frame.
const OUTPUT_FLUSH_MS = 16;
const OUTPUT_FLUSH_BYTES = 64 * 1024;

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
}

interface RunRecord {
  runId: string;
  pid: number;
  pty: ScriptPty;
  projectId: string;
  worktreeId: string;
  // Kept alongside the id so a worktree that has vanished from disk can
  // still be named in the reap notice and probed by path. Neither is
  // recoverable from the path-derived id after the fact.
  worktreeName: string;
  worktreePath: string;
  scriptName: string;
  // The shell command we launched. Persisted with the record, where it
  // is one of the facts that proves a surviving pid is still ours.
  command: string;
  startedAt: number;
  exited: boolean;
  cancelling: boolean;
  done: Promise<void>;
  notify: NotifyScriptEvent;
  // Sends whatever PTY output is pooled for the next frame (see
  // OUTPUT_FLUSH_MS). Anything else that emits into the run's stream
  // must call it first so it lands after the output that preceded it.
  flushOutput: () => void;
}

const runningScripts = new Map<string, RunRecord>();

// Mirror the live map to disk on every spawn and every settle, so a
// crash that skips the kill chains leaves the next boot something to
// sweep (see ./persistence.ts).
function persistSnapshot(): void {
  const scripts: PersistedScript[] = Array.from(
    runningScripts.values(),
    (record) => ({
      runId: record.runId,
      pid: record.pid,
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      startedAt: record.startedAt,
      command: record.command,
    }),
  );
  persistRunningScripts(scripts);
}

// Ref-counted: overlapping deleters can mark the same worktree (a
// per-worktree delete racing a nuke that lists it too), and the guard
// must hold until the LAST one finishes -- with a plain Set, whichever
// finally ran first would drop the other's still-needed mark.
const inflightDeleteCounts = new Map<string, number>();
const inflightProjectDeleteIds = new Set<string>();
let shuttingDown = false;

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

// The one place the tombstone protocol is spelled out: refuse a
// concurrent mutation of the same worktree, mark the id so a still-
// running create lifecycle can't spawn steps into a directory that is
// vanishing or moving, reap app-spawned scripts before the mutation
// (a dev server would otherwise outlive its worktree or keep running
// in the old path), and always clear the mark. Callers supply the
// busy message because the operations differ (removed vs moved).
export async function withDeleteInflight<T>(
  worktreeId: string,
  busyMessage: string,
  run: () => Promise<T>,
): Promise<T> {
  if (getInflightDeleteIds().has(worktreeId)) {
    throw new Error(busyMessage);
  }
  markDeleteInflight(worktreeId);
  try {
    await killScriptsForWorktree(worktreeId);
    return await run();
  } finally {
    clearDeleteInflight(worktreeId);
  }
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

// Extra sources of in-flight lifecycle work that live outside this
// module (the CLI runner registers its child count). Aggregating here
// means every getBusyOperations caller sees the full picture instead
// of each consumer patching the count locally.
const inflightContributors: Array<() => number> = [];

export function registerInflightContributor(count: () => number): void {
  inflightContributors.push(count);
}

// One entry per worktree that currently has live scripts, with what it
// takes to identify that worktree after its directory is gone. The
// removed-worktree reaper uses this as its "worktrees the app knows
// existed" list, so it never has to cache one of its own.
export interface RunningScriptWorktree {
  projectId: string;
  worktreeId: string;
  worktreeName: string;
  worktreePath: string;
  scriptCount: number;
}

export function getRunningScriptWorktrees(): RunningScriptWorktree[] {
  const byWorktree = new Map<string, RunningScriptWorktree>();
  for (const record of runningScripts.values()) {
    if (record.exited) continue;
    const existing = byWorktree.get(record.worktreeId);
    if (existing) {
      existing.scriptCount++;
      continue;
    }
    byWorktree.set(record.worktreeId, {
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      worktreeName: record.worktreeName,
      worktreePath: record.worktreePath,
      scriptCount: 1,
    });
  }
  return Array.from(byWorktree.values());
}

export function getBusyOperations(): BusyOperations {
  let contributed = 0;
  for (const count of inflightContributors) contributed += count();
  return {
    runningScripts: runningScripts.size,
    inflightDeletes:
      inflightDeleteCounts.size + inflightProjectDeleteIds.size + contributed,
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

async function killRecord(record: RunRecord, opts: KillOptions): Promise<void> {
  if (record.exited) return;
  if (record.cancelling) {
    // Another caller is already escalating; wait for it, but bounded --
    // an unkillable child must not wedge this caller's chain too.
    await waitWithTimeout(record.done, DEFAULT_GRACE_MS + UNKILLABLE_WAIT_MS);
    return;
  }
  record.cancelling = true;

  if (opts.reason) {
    record.flushOutput();
    record.notify({
      runId: record.runId,
      kind: "data",
      data: `\r\n\x1b[2m[${opts.reason}]\x1b[0m\r\n`,
    });
  }

  await signalTree(record.pid, "SIGTERM");
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const exited = await waitWithTimeout(record.done, graceMs);
  if (exited) return;

  await signalTree(record.pid, "SIGKILL");
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
  // Runs must not land in a worktree that's mid-delete: the delete flow
  // snapshots running scripts once (killScriptsForWorktree), so a spawn
  // slipping in after that leaves a live dev server whose cwd is being
  // rm'd.
  if (inflightDeleteCounts.has(args.worktree.id)) {
    throw new Error("This worktree is being deleted.");
  }
  if (inflightProjectDeleteIds.has(args.project.id)) {
    throw new Error("This project is being removed.");
  }

  // node-pty's helper does the chdir itself and exits 1 without a word
  // when it fails, which the console would show as a bare "exit 1".
  // Name the cause here instead.
  if (!existsSync(args.worktree.path)) {
    throw new Error(`Worktree directory is missing: ${args.worktree.path}`);
  }

  const runId = randomUUID();

  // Inherits the app's environment plus the SHIGOMORI_* contract vars,
  // and deliberately adds no state-root pin: a script's whole process
  // tree inherits this, so naming a root here would follow the user's
  // command into anything it starts (see initShigomoriRoot). TERM and
  // COLORTERM advertise what xterm in the renderer renders. FORCE_COLOR
  // is for the tools a runner (turbo, concurrently, a `| tee`) drives
  // through pipes, which can't see the PTY and would go monochrome.
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "1",
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

  // Throws when no process could be started. The caller's IPC rejection
  // carries the message into the console.
  const pty: ScriptPty = spawnScript({
    command: args.command,
    cwd: args.worktree.path,
    env,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });

  // The PTY is one ordered byte stream (stdout and stderr share the
  // terminal), so the renderer's xterm sees exactly what a real
  // terminal would, and concatenating reads before sending changes
  // nothing it renders.
  let pendingOutput = "";
  let flushTimer: NodeJS.Timeout | null = null;
  const flushOutput = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingOutput) return;
    const data = pendingOutput;
    pendingOutput = "";
    args.notify({ runId, kind: "data", data });
  };

  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const record: RunRecord = {
    runId,
    pid: pty.pid,
    pty,
    projectId: args.project.id,
    worktreeId: args.worktree.id,
    worktreeName: args.worktree.name,
    worktreePath: args.worktree.path,
    scriptName: args.scriptName,
    command: args.command,
    startedAt: Date.now(),
    exited: false,
    cancelling: false,
    done,
    notify: args.notify,
    flushOutput,
  };
  runningScripts.set(runId, record);
  persistSnapshot();

  pty.onData((data) => {
    pendingOutput += data;
    if (pendingOutput.length >= OUTPUT_FLUSH_BYTES) flushOutput();
    else if (!flushTimer) flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
  });

  // A read error on the PTY master (anything but the EIO that means the
  // child hung up) is rethrown by node-pty unless someone else listens
  // for it, and an uncaught throw here takes the whole main process
  // down. node-pty closes the PTY first, so the exit event follows.
  (pty as unknown as NodeJS.EventEmitter).on("error", (error: unknown) => {
    flushOutput();
    args.notify({ runId, kind: "error", data: errorMessageOf(error) });
  });

  // node-pty reports exit only after the terminal stream has drained
  // (or a short grace period when a backgrounded grandchild still holds
  // the PTY open), so the run's last output never races the exit event
  // that makes the renderer unbind the runId. That grace is also the
  // only window in which a kill could target an already-reaped pid.
  // It is a couple hundred milliseconds, and the target would have to
  // be recycled as a group leader to be hit at all.
  pty.onExit(({ exitCode, signal }) => {
    // SIGTERM via our kill path commonly surfaces as exit 143 (128+15)
    // because the shell wrapping the user's command translated the
    // signal into an exit code. If we initiated the cancel, report
    // null code so the UI shows "stopped" not "failed".
    const wasSignal = signal !== undefined && signal !== 0;
    const reported = record.cancelling || wasSignal ? null : exitCode;
    flushOutput();
    args.notify({ runId, kind: "exit", code: reported });
    record.exited = true;
    resolveDone();
    runningScripts.delete(runId);
    persistSnapshot();
  });

  return runId;
}

// Keystrokes from the console. A no-op when the run isn't one of ours
// (already exited, or a lifecycle script the CLI ran on the app's behalf
// -- those stream output through the same events but have no PTY here).
// Both calls can also fail on a PTY that is being torn down (the exit
// event is already on its way), which is not worth reporting.
export function writeToScript(runId: string, data: string): void {
  try {
    runningScripts.get(runId)?.pty.write(data);
  } catch {}
}

// The console's viewport size, so full-width output and TUIs lay out
// for the space they actually have.
export function resizeScript(runId: string, cols: number, rows: number): void {
  try {
    runningScripts.get(runId)?.pty.resize(cols, rows);
  } catch {}
}

export async function cancelScript(runId: string): Promise<boolean> {
  const record = runningScripts.get(runId);
  if (!record) return false;
  await killRecord(record, { reason: "Cancelled by user" });
  return true;
}

async function killMatching(
  predicate: (record: RunRecord) => boolean,
  reason: string,
  opts: KillOptions = {},
): Promise<void> {
  const targets = Array.from(runningScripts.values()).filter(
    (r) => !r.exited && predicate(r),
  );
  if (targets.length === 0) return;
  await Promise.all(targets.map((r) => killRecord(r, { reason, ...opts })));
}

export async function killScriptsForWorktree(
  worktreeId: string,
): Promise<void> {
  await killMatching((r) => r.worktreeId === worktreeId, "Worktree removed");
}

export async function killScriptsForProject(projectId: string): Promise<void> {
  await killMatching((r) => r.projectId === projectId, "Project removed");
}

// The one caller that tunes the grace period is the quit path, which
// can't wait out the default before Electron tears the process down.
export async function killAllScripts(opts: KillOptions = {}): Promise<void> {
  await killMatching(() => true, "App quit", opts);
}

// Synchronous best-effort kill for every running script's tree. Used
// by the update-install quit path, where we can't await the full kill
// chain (that would block the handoff to the detached installer waiting
// on our exit) but still want well-behaved scripts to clean up before
// Electron tears the main process down.
export function signalAllScriptsBestEffort(signal: NodeJS.Signals): void {
  for (const record of runningScripts.values()) {
    if (record.exited) continue;
    signalTreeBestEffort(record.pid, signal);
  }
}
