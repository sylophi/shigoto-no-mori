// In-memory store for in-flight + most-recent script runs, keyed by
// (projectId, worktreeId, slot). One global subscription drains the
// main-process ScriptEvent channel; events route to the right record
// via a runId→key index built when a run starts.
//
// React reads via `useScriptRunState(key)`. The store survives
// navigation but not a renderer reload — matches the user-confirmed
// "in-memory only" scope.
//
// Snapshots are immutable: every transition replaces the record with
// a new object. `useSyncExternalStore` relies on Object.is to detect
// changes, so mutating in place would silently skip re-renders.
import { useSyncExternalStore } from "react";
import type { ScriptEvent } from "@shared/schemas";
import { singletonInit } from "@/lib/singletonInit";
import { toast } from "@/lib/toast";
import { scriptKey, type ScriptKey, type ScriptSlot } from "./scriptSlot";

// Re-export the slot codec so existing importers from "@/store/scriptRuns"
// keep working without churning every consumer.
export {
  paramToSlot,
  scriptKey,
  slotLabel,
  slotToParam,
  type ScriptKey,
  type ScriptSlot,
} from "./scriptSlot";

// Max number of output chunks kept for replay. Chunks vary in size (one
// "data" event may carry a single byte or a 4 KB burst), so this is a
// rough ceiling. The console replays the buffer on mount.
const MAX_CHUNKS = 5_000;

export type RunStatus = "idle" | "starting" | "running" | "exited" | "errored";

export interface ScriptRunState {
  runId: string | null;
  status: RunStatus;
  // Raw output chunks (already utf8-decoded). The console writes them
  // straight into xterm; we don't try to interpret ANSI here.
  output: string[];
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
  cancelling: boolean;
}

type SlotKind =
  | "setup"
  | "teardown"
  | "package"
  | "portPoolProvision"
  | "portPoolRelease";

function deriveSlotKind(slot: ScriptSlot): SlotKind {
  if (slot.kind === "portPool") {
    return slot.phase === "provision" ? "portPoolProvision" : "portPoolRelease";
  }
  return slot.kind;
}

interface RunMeta {
  worktreeId: string;
  slotKind: SlotKind;
  exitDeferred: {
    promise: Promise<number | null>;
    resolve: (code: number | null) => void;
  } | null;
}

export type ScriptActivityKind = "setup" | "teardown" | "package";

const states = new Map<ScriptKey, ScriptRunState>();
const meta = new Map<ScriptKey, RunMeta>();
const runIdToKey = new Map<string, ScriptKey>();
// Events that arrived before the `scripts.run` invoke resolved and let
// us bind the runId to a key. A spawned child can emit its first bytes
// before the IPC return reaches the renderer, so buffer here and flush
// in start() once we know the runId.
const pendingByRunId = new Map<string, ScriptEvent[]>();
const perKeySubs = new Map<ScriptKey, Set<() => void>>();
const worktreeSubs = new Map<string, Set<() => void>>();

const EMPTY_STATE: ScriptRunState = Object.freeze({
  runId: null,
  status: "idle" as const,
  output: [],
  exitCode: null,
  startedAt: null,
  endedAt: null,
  cancelling: false,
});

function notify(key: ScriptKey) {
  const subs = perKeySubs.get(key);
  if (!subs) return;
  for (const cb of subs) cb();
}

function notifyWorktree(worktreeId: string) {
  const subs = worktreeSubs.get(worktreeId);
  if (!subs) return;
  for (const cb of subs) cb();
}

function setStateWithActivity(
  key: ScriptKey,
  update: (prev: ScriptRunState) => ScriptRunState,
): void {
  const prev = getState(key);
  const next = update(prev);
  if (next === prev) return;
  states.set(key, next);
  notify(key);
  // Sidebar activity only depends on status; log appends don't change it.
  if (prev.status !== next.status) {
    const m = meta.get(key);
    if (m) notifyWorktree(m.worktreeId);
  }
}

function getState(key: ScriptKey): ScriptRunState {
  return states.get(key) ?? EMPTY_STATE;
}

function appendChunk(state: ScriptRunState, chunk: string): ScriptRunState {
  const output =
    state.output.length >= MAX_CHUNKS
      ? [...state.output.slice(state.output.length - MAX_CHUNKS + 1), chunk]
      : [...state.output, chunk];
  return { ...state, output };
}

function exitSentinel(code: number | null): string {
  // Dim divider so users can see where the run ended even if the
  // program's last line didn't end with a newline.
  if (code === null) return "\r\n\x1b[2m── stopped ──\x1b[0m\r\n";
  if (code === 0) return "\r\n\x1b[2m── done ──\x1b[0m\r\n";
  return `\r\n\x1b[31m── exit ${code} ──\x1b[0m\r\n`;
}

function applyEvent(key: ScriptKey, event: ScriptEvent): void {
  if (event.kind === "data") {
    setStateWithActivity(key, (s) => appendChunk(s, event.data));
    return;
  }
  if (event.kind === "error") {
    setStateWithActivity(key, (s) => ({
      ...appendChunk(s, `\r\n\x1b[31m${event.data}\x1b[0m\r\n`),
      status: "errored",
    }));
    return;
  }
  if (event.kind === "exit") {
    const m = meta.get(key);
    m?.exitDeferred?.resolve(event.code);
    if (m) meta.set(key, { ...m, exitDeferred: null });
    runIdToKey.delete(event.runId);
    setStateWithActivity(key, (s) => ({
      ...appendChunk(s, exitSentinel(event.code)),
      exitCode: event.code,
      status: "exited",
      endedAt: Date.now(),
      cancelling: false,
    }));
    if (event.code !== 0 && m) toastLifecycleFailure(m.slotKind, event.code);
  }
}

// Setup and port-pool-provision run in the background after worktree
// create returns, so the mutation can't surface a failed exit anymore.
// Teardown / port-pool-release have their own retry UI and don't need
// a toast on top. Package scripts are user-initiated; their console is
// already visible.
function toastLifecycleFailure(
  slotKind: SlotKind,
  exitCode: number | null,
): void {
  const label =
    slotKind === "setup"
      ? "Setup"
      : slotKind === "portPoolProvision"
        ? "Port-pool provision"
        : null;
  if (!label) return;
  toast.warning(`${label} didn't complete cleanly`, {
    description:
      exitCode === null
        ? "See the script console for details."
        : `Exited with code ${exitCode}.`,
  });
}

function setMetaWithDeferred(
  key: ScriptKey,
  worktreeId: string,
  slot: ScriptSlot,
): void {
  const prev = states.get(key);
  if (prev?.runId) runIdToKey.delete(prev.runId);
  let deferredResolve!: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    deferredResolve = resolve;
  });
  meta.set(key, {
    worktreeId,
    slotKind: deriveSlotKind(slot),
    exitDeferred: { promise: exitPromise, resolve: deferredResolve },
  });
}

function bindRunIdAndDrain(key: ScriptKey, runId: string): void {
  runIdToKey.set(runId, key);
  const pending = pendingByRunId.get(runId);
  if (pending) {
    pendingByRunId.delete(runId);
    for (const queued of pending) applyEvent(key, queued);
  }
}

function bindStarted(event: Extract<ScriptEvent, { kind: "started" }>): void {
  const key = scriptKey(event.projectId, event.worktreeId, event.slot);
  setMetaWithDeferred(key, event.worktreeId, event.slot);

  setStateWithActivity(key, () => ({
    runId: event.runId,
    status: "running",
    output: [],
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    cancelling: false,
  }));

  bindRunIdAndDrain(key, event.runId);
}

function handleEvent(event: ScriptEvent): void {
  if (event.kind === "started") {
    bindStarted(event);
    return;
  }
  const key = runIdToKey.get(event.runId);
  if (key) {
    applyEvent(key, event);
    return;
  }
  const bucket = pendingByRunId.get(event.runId) ?? [];
  bucket.push(event);
  pendingByRunId.set(event.runId, bucket);
}

export const ensureScriptEventSubscription = singletonInit(() => {
  window.api.scripts.onEvent(handleEvent);
});

interface StartInput {
  key: ScriptKey;
  worktreeId: string;
  slot: ScriptSlot;
  runner: () => Promise<{ runId: string }>;
}

async function start(input: StartInput): Promise<void> {
  setMetaWithDeferred(input.key, input.worktreeId, input.slot);

  setStateWithActivity(input.key, () => ({
    runId: null,
    status: "starting",
    output: [],
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    cancelling: false,
  }));

  let runId: string;
  try {
    const result = await input.runner();
    runId = result.runId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStateWithActivity(input.key, (s) => ({
      ...appendChunk(s, `\r\n\x1b[31m${message}\x1b[0m\r\n`),
      status: "errored",
      endedAt: Date.now(),
    }));
    const m = meta.get(input.key);
    m?.exitDeferred?.resolve(null);
    if (m) meta.set(input.key, { ...m, exitDeferred: null });
    throw err;
  }

  setStateWithActivity(input.key, (s) => ({ ...s, runId, status: "running" }));

  // Drain any events the child produced before we knew the runId. Order
  // is preserved (push/iterate FIFO) so xterm replay stays coherent.
  bindRunIdAndDrain(input.key, runId);
}

async function cancel(key: ScriptKey): Promise<void> {
  const state = states.get(key);
  if (!state || !state.runId) return;
  if (state.status !== "running" && state.status !== "starting") return;
  setStateWithActivity(key, (s) =>
    s.cancelling ? s : { ...s, cancelling: true },
  );
  try {
    await window.api.scripts.cancel(state.runId);
  } catch {
    setStateWithActivity(key, (s) =>
      s.status === "running" || s.status === "starting"
        ? { ...s, cancelling: false }
        : s,
    );
  }
}

function clear(key: ScriptKey): void {
  const state = states.get(key);
  if (!state) return;
  if (state.status === "running" || state.status === "starting") return;
  if (state.runId) runIdToKey.delete(state.runId);
  states.delete(key);
  meta.delete(key);
  notify(key);
}

// Drop every run record (and runId mapping) tied to a worktree.
// Used when a worktree is removed so the store doesn't leak.
export function clearScriptRunsForWorktree(worktreeId: string): void {
  let touched = false;
  for (const [key, m] of meta) {
    if (m.worktreeId !== worktreeId) continue;
    const s = states.get(key);
    if (s?.runId) runIdToKey.delete(s.runId);
    states.delete(key);
    meta.delete(key);
    notify(key);
    touched = true;
  }
  if (touched) notifyWorktree(worktreeId);
}

async function awaitExit(key: ScriptKey): Promise<number | null> {
  const m = meta.get(key);
  if (m?.exitDeferred) return m.exitDeferred.promise;
  return states.get(key)?.exitCode ?? null;
}

function subscribe(key: ScriptKey, cb: () => void): () => void {
  let subs = perKeySubs.get(key);
  if (!subs) {
    subs = new Set();
    perKeySubs.set(key, subs);
  }
  subs.add(cb);
  return () => {
    const bucket = perKeySubs.get(key);
    if (!bucket) return;
    bucket.delete(cb);
    if (bucket.size === 0) perKeySubs.delete(key);
  };
}

function subscribeWorktree(worktreeId: string, cb: () => void): () => void {
  let subs = worktreeSubs.get(worktreeId);
  if (!subs) {
    subs = new Set();
    worktreeSubs.set(worktreeId, subs);
  }
  subs.add(cb);
  return () => {
    const bucket = worktreeSubs.get(worktreeId);
    if (!bucket) return;
    bucket.delete(cb);
    if (bucket.size === 0) worktreeSubs.delete(worktreeId);
  };
}

// Highest-priority active slot for the worktree, or null if nothing is
// running. Teardown trumps setup trumps package because it's the most
// consequential state to surface in the sidebar.
function getActivityKind(worktreeId: string): ScriptActivityKind | null {
  let hasSetup = false;
  let hasPackage = false;
  for (const [key, m] of meta) {
    if (m.worktreeId !== worktreeId) continue;
    const s = states.get(key);
    if (!s) continue;
    if (s.status !== "starting" && s.status !== "running") continue;
    // Release is conceptually like teardown -- highest priority tier.
    if (m.slotKind === "teardown" || m.slotKind === "portPoolRelease") {
      return "teardown";
    }
    if (m.slotKind === "setup" || m.slotKind === "portPoolProvision") {
      hasSetup = true;
      continue;
    }
    if (m.slotKind === "package") {
      hasPackage = true;
    }
  }
  if (hasSetup) return "setup";
  if (hasPackage) return "package";
  return null;
}

// True if any package script for this worktree has run (or is
// running). Drives whether the package.json section in the worktree
// detail expands by default.
function hasWorktreePackageActivity(worktreeId: string): boolean {
  for (const [key, m] of meta) {
    if (m.worktreeId !== worktreeId) continue;
    if (m.slotKind !== "package") continue;
    const s = states.get(key);
    if (s && s.status !== "idle") return true;
  }
  return false;
}

export const scriptRuns = {
  start,
  cancel,
  clear,
  awaitExit,
  snapshot: getState,
  subscribe,
  subscribeWorktree,
  getActivityKind,
  hasWorktreePackageActivity,
};

export function useWorktreeScriptActivity(
  worktreeId: string,
): ScriptActivityKind | null {
  return useSyncExternalStore(
    (cb) => scriptRuns.subscribeWorktree(worktreeId, cb),
    () => scriptRuns.getActivityKind(worktreeId),
    () => null,
  );
}

export function useWorktreeHasPackageActivity(worktreeId: string): boolean {
  return useSyncExternalStore(
    (cb) => scriptRuns.subscribeWorktree(worktreeId, cb),
    () => scriptRuns.hasWorktreePackageActivity(worktreeId),
    () => false,
  );
}

export function useScriptRunState(key: ScriptKey): ScriptRunState {
  return useSyncExternalStore(
    (cb) => scriptRuns.subscribe(key, cb),
    () => scriptRuns.snapshot(key),
    () => EMPTY_STATE,
  );
}
