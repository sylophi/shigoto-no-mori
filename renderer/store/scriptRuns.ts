// In-memory store for in-flight + most-recent script runs, keyed by
// (projectId, worktreeId, slot). One global subscription drains the
// main-process ScriptEvent channel; events route to the right record
// via a runId→key index built when a run starts.
//
// React reads via `useScriptRunState(key)`. The store survives
// navigation but not a renderer reload -- matches the user-confirmed
// "in-memory only" scope.
//
// Snapshots are immutable: every transition replaces the record with
// a new object. `useSyncExternalStore` relies on Object.is to detect
// changes, so mutating in place would silently skip re-renders.
import { useSyncExternalStore } from "react";
import type { ScriptEvent } from "@shared/schemas";
import { toast } from "@/lib/toast";
import { assertNever } from "@/lib/utils";
import type { RendererApi } from "@/window";
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

// Cap per-runId pre-bind buffers. The legitimate buffering window is one
// IPC round-trip (events arriving before `scripts.run` resolves), so a
// bucket this deep means the runId will never bind -- e.g. a script that
// was already streaming when the renderer reloaded and rebuilt this
// store. Without a cap those orphaned buckets grow for as long as the
// script keeps producing output.
const MAX_PENDING_CHUNKS = 500;

// "started" is handled separately by handleEvent (which binds the runId
// before delegating to applyEvent). Narrowing the post-start union lets
// applyEvent's switch stay exhaustive with assertNever as the safety net.
type PostStartEvent = Exclude<ScriptEvent, { kind: "started" }>;

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

const EMPTY_STATE: ScriptRunState = Object.freeze({
  runId: null,
  status: "idle" as const,
  output: [],
  exitCode: null,
  startedAt: null,
  endedAt: null,
  cancelling: false,
});

interface StartInput {
  key: ScriptKey;
  worktreeId: string;
  slot: ScriptSlot;
  runner: () => Promise<{ runId: string }>;
}

type ScriptsApi = Pick<RendererApi["scripts"], "cancel" | "onEvent">;

type WarnFn = (title: string, options?: { description?: string }) => unknown;

class ScriptRunsStore {
  private states = new Map<ScriptKey, ScriptRunState>();
  private meta = new Map<ScriptKey, RunMeta>();
  private runIdToKey = new Map<string, ScriptKey>();
  // Events that arrived before the `scripts.run` invoke resolved and let
  // us bind the runId to a key. A spawned child can emit its first bytes
  // before the IPC return reaches the renderer, so buffer here and flush
  // in start() once we know the runId. "started" events are dispatched
  // directly by handleEvent, so they never reach this buffer.
  private pendingByRunId = new Map<string, PostStartEvent[]>();
  private perKeySubs = new Map<ScriptKey, Set<() => void>>();
  private worktreeSubs = new Map<string, Set<() => void>>();
  private unsubscribeIpc: (() => void) | null = null;
  private api: ScriptsApi;
  private warn: WarnFn;

  constructor(api: ScriptsApi, warn: WarnFn) {
    this.api = api;
    this.warn = warn;
  }

  start(): void {
    if (this.unsubscribeIpc) return;
    this.unsubscribeIpc = this.api.onEvent((event) => this.handleEvent(event));
  }

  dispose(): void {
    this.unsubscribeIpc?.();
    this.unsubscribeIpc = null;
    this.states.clear();
    this.meta.clear();
    this.runIdToKey.clear();
    this.pendingByRunId.clear();
    this.perKeySubs.clear();
    this.worktreeSubs.clear();
  }

  async run(input: StartInput): Promise<void> {
    this.setMetaWithDeferred(input.key, input.worktreeId, input.slot);

    this.setStateWithActivity(input.key, () => ({
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
      this.setStateWithActivity(input.key, (s) => ({
        ...appendChunk(s, `\r\n\x1b[31m${message}\x1b[0m\r\n`),
        status: "errored",
        endedAt: Date.now(),
      }));
      const m = this.meta.get(input.key);
      m?.exitDeferred?.resolve(null);
      if (m) this.meta.set(input.key, { ...m, exitDeferred: null });
      throw err;
    }

    this.setStateWithActivity(input.key, (s) => ({
      ...s,
      runId,
      status: "running",
    }));

    // Drain any events the child produced before we knew the runId. Order
    // is preserved (push/iterate FIFO) so xterm replay stays coherent.
    this.bindRunIdAndDrain(input.key, runId);
  }

  async cancel(key: ScriptKey): Promise<void> {
    const state = this.states.get(key);
    if (!state || !state.runId) return;
    if (state.status !== "running" && state.status !== "starting") return;
    this.setStateWithActivity(key, (s) =>
      s.cancelling ? s : { ...s, cancelling: true },
    );
    try {
      await this.api.cancel(state.runId);
    } catch {
      this.setStateWithActivity(key, (s) =>
        s.status === "running" || s.status === "starting"
          ? { ...s, cancelling: false }
          : s,
      );
    }
  }

  clear(key: ScriptKey): void {
    const state = this.states.get(key);
    if (!state) return;
    if (state.status === "running" || state.status === "starting") return;
    if (state.runId) this.runIdToKey.delete(state.runId);
    this.states.delete(key);
    this.meta.delete(key);
    this.notify(key);
  }

  // Called when a worktree is removed (delete / relocate / convert);
  // otherwise per-worktree state and runId mappings would leak across
  // worktrees that no longer exist on disk.
  clearForWorktree(worktreeId: string): void {
    let touched = false;
    for (const [key, m] of this.meta) {
      if (m.worktreeId !== worktreeId) continue;
      const s = this.states.get(key);
      if (s?.runId) this.runIdToKey.delete(s.runId);
      this.states.delete(key);
      this.meta.delete(key);
      this.notify(key);
      touched = true;
    }
    if (touched) this.notifyWorktree(worktreeId);
  }

  awaitExit(key: ScriptKey): Promise<number | null> {
    const m = this.meta.get(key);
    if (m?.exitDeferred) return m.exitDeferred.promise;
    return Promise.resolve(this.states.get(key)?.exitCode ?? null);
  }

  snapshot(key: ScriptKey): ScriptRunState {
    return this.states.get(key) ?? EMPTY_STATE;
  }

  subscribe(key: ScriptKey, cb: () => void): () => void {
    let subs = this.perKeySubs.get(key);
    if (!subs) {
      subs = new Set();
      this.perKeySubs.set(key, subs);
    }
    subs.add(cb);
    return () => {
      const bucket = this.perKeySubs.get(key);
      if (!bucket) return;
      bucket.delete(cb);
      if (bucket.size === 0) this.perKeySubs.delete(key);
    };
  }

  subscribeWorktree(worktreeId: string, cb: () => void): () => void {
    let subs = this.worktreeSubs.get(worktreeId);
    if (!subs) {
      subs = new Set();
      this.worktreeSubs.set(worktreeId, subs);
    }
    subs.add(cb);
    return () => {
      const bucket = this.worktreeSubs.get(worktreeId);
      if (!bucket) return;
      bucket.delete(cb);
      if (bucket.size === 0) this.worktreeSubs.delete(worktreeId);
    };
  }

  // Highest-priority active slot for the worktree, or null if nothing is
  // running. Teardown trumps setup trumps package because it's the most
  // consequential state to surface in the sidebar.
  getActivityKind(worktreeId: string): ScriptActivityKind | null {
    let hasSetup = false;
    let hasPackage = false;
    for (const [key, m] of this.meta) {
      if (m.worktreeId !== worktreeId) continue;
      const s = this.states.get(key);
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
  hasWorktreePackageActivity(worktreeId: string): boolean {
    for (const [key, m] of this.meta) {
      if (m.worktreeId !== worktreeId) continue;
      if (m.slotKind !== "package") continue;
      const s = this.states.get(key);
      if (s && s.status !== "idle") return true;
    }
    return false;
  }

  private notify(key: ScriptKey): void {
    const subs = this.perKeySubs.get(key);
    if (!subs) return;
    for (const cb of subs) cb();
  }

  private notifyWorktree(worktreeId: string): void {
    const subs = this.worktreeSubs.get(worktreeId);
    if (!subs) return;
    for (const cb of subs) cb();
  }

  private setStateWithActivity(
    key: ScriptKey,
    update: (prev: ScriptRunState) => ScriptRunState,
  ): void {
    const prev = this.states.get(key) ?? EMPTY_STATE;
    const next = update(prev);
    if (next === prev) return;
    this.states.set(key, next);
    this.notify(key);
    // Sidebar activity only depends on status; log appends don't change it.
    if (prev.status !== next.status) {
      const m = this.meta.get(key);
      if (m) this.notifyWorktree(m.worktreeId);
    }
  }

  private applyEvent(key: ScriptKey, event: PostStartEvent): void {
    switch (event.kind) {
      case "data":
        this.setStateWithActivity(key, (s) => appendChunk(s, event.data));
        return;
      case "error":
        this.setStateWithActivity(key, (s) => ({
          ...appendChunk(s, `\r\n\x1b[31m${event.data}\x1b[0m\r\n`),
          status: "errored",
        }));
        return;
      case "exit": {
        const m = this.meta.get(key);
        m?.exitDeferred?.resolve(event.code);
        if (m) this.meta.set(key, { ...m, exitDeferred: null });
        this.runIdToKey.delete(event.runId);
        this.setStateWithActivity(key, (s) => ({
          ...appendChunk(s, exitSentinel(event.code)),
          exitCode: event.code,
          status: "exited",
          endedAt: Date.now(),
          cancelling: false,
        }));
        if (event.code !== 0 && m) {
          this.toastLifecycleFailure(m.slotKind, event.code);
        }
        return;
      }
      default:
        assertNever(event);
    }
  }

  // Setup and port-pool-provision run in the background after worktree
  // create returns, so the mutation can't surface a failed exit anymore.
  // Teardown / port-pool-release have their own retry UI and don't need
  // a toast on top. Package scripts are user-initiated; their console is
  // already visible.
  private toastLifecycleFailure(
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
    this.warn(`${label} didn't complete cleanly`, {
      description:
        exitCode === null
          ? "See the script console for details."
          : `Exited with code ${exitCode}.`,
    });
  }

  private setMetaWithDeferred(
    key: ScriptKey,
    worktreeId: string,
    slot: ScriptSlot,
  ): void {
    const prev = this.states.get(key);
    if (prev?.runId) this.runIdToKey.delete(prev.runId);
    let deferredResolve!: (code: number | null) => void;
    const exitPromise = new Promise<number | null>((resolve) => {
      deferredResolve = resolve;
    });
    this.meta.set(key, {
      worktreeId,
      slotKind: deriveSlotKind(slot),
      exitDeferred: { promise: exitPromise, resolve: deferredResolve },
    });
  }

  private bindRunIdAndDrain(key: ScriptKey, runId: string): void {
    this.runIdToKey.set(runId, key);
    const pending = this.pendingByRunId.get(runId);
    if (pending) {
      this.pendingByRunId.delete(runId);
      for (const queued of pending) this.applyEvent(key, queued);
    }
  }

  private bindStarted(event: Extract<ScriptEvent, { kind: "started" }>): void {
    const key = scriptKey(event.projectId, event.worktreeId, event.slot);
    this.setMetaWithDeferred(key, event.worktreeId, event.slot);

    this.setStateWithActivity(key, () => ({
      runId: event.runId,
      status: "running",
      output: [],
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      cancelling: false,
    }));

    this.bindRunIdAndDrain(key, event.runId);
  }

  private handleEvent(event: ScriptEvent): void {
    if (event.kind === "started") {
      this.bindStarted(event);
      return;
    }
    const key = this.runIdToKey.get(event.runId);
    if (key) {
      this.applyEvent(key, event);
      return;
    }
    const bucket = this.pendingByRunId.get(event.runId) ?? [];
    if (bucket.length >= MAX_PENDING_CHUNKS) bucket.shift();
    bucket.push(event);
    this.pendingByRunId.set(event.runId, bucket);
  }
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

// `start()` is called by the renderer entry point so subscription
// lifecycle has a single owner. Importing this module just constructs
// the singleton; it does not attach IPC listeners as a side effect.
export const scriptRuns = new ScriptRunsStore(
  window.api.scripts,
  (title, options) => toast.warning(title, options),
);

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
