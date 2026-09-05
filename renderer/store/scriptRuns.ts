// In-memory store for in-flight + most-recent script runs, keyed by
// (projectId, worktreeId, slot). One store per device: each drains the
// ScriptEvent channel of the device its api names (this machine's over
// the preload bridge, a peer's over its direct session), and events
// route to the right record via a runId→key index built when a run
// starts. Worktree ids are path hashes that can collide across the
// owner's machines, so a run's key is only unambiguous inside its
// device's store.
//
// React reads via the hooks in hooks/scripts/useScriptRuns.ts, which
// resolve the store from the host scope. A store survives navigation
// but not a renderer reload -- matches the user-confirmed "in-memory
// only" scope.
//
// Snapshots are immutable: every transition replaces the record with
// a new object. `useSyncExternalStore` relies on Object.is to detect
// changes, so mutating in place would silently skip re-renders.
import type { RemovedWorktreeScripts, ScriptEvent } from "@shared/schemas";
import { localDeviceId } from "@/lib/queryKeys";
import { apiFor } from "@/lib/remote/remoteDeviceSync";
import { toast } from "@/lib/toast";
import { assertNever } from "@/lib/utils";
import type { RendererApi } from "@/window";
import { scriptKey, type ScriptKey, type ScriptSlot } from "./scriptSlot";
import { errorMessageOf } from "@shared/errors";
import { KeyedSubscribers } from "./keyedSubscribers";

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

// Output kept per run for replay when a console mounts, in bytes: more
// than the terminal's own scrollback can show, small enough that the
// replay parses in a moment and that a window's worth of finished runs
// stays cheap to keep around.
const MAX_OUTPUT_BYTES = 1024 * 1024;

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
  // Whether any output has arrived. The output itself is a log beside
  // the snapshot (readOutput / subscribeOutput): a render per PTY read
  // would be the hot path, and status UI only needs to know there is
  // something to show or clear.
  hasOutput: boolean;
  // Whether keystrokes reach the process. True for runs the app spawned
  // (they own a PTY in main), false for lifecycle scripts the CLI ran
  // on the app's behalf, which stream output through the same events
  // but have nothing to type into.
  interactive: boolean;
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

interface OutputLog {
  chunks: string[];
  // Sum of chunk lengths, so trimming needn't re-measure the log.
  bytes: number;
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

export const EMPTY_STATE: ScriptRunState = Object.freeze({
  runId: null,
  status: "idle" as const,
  hasOutput: false,
  interactive: false,
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

type ScriptsApi = Pick<
  RendererApi["scripts"],
  "cancel" | "write" | "resize" | "onEvent" | "onStoppedForRemovedWorktree"
>;

type WarnFn = (title: string, options?: { description?: string }) => unknown;

export class ScriptRunsStore {
  private states = new Map<ScriptKey, ScriptRunState>();
  // Per-run output log, keyed like states, mutated in place. Consoles
  // catch up from it on mount and follow it through outputSubs.
  private buffers = new Map<ScriptKey, OutputLog>();
  private outputSubs = new KeyedSubscribers<ScriptKey, string>();
  private meta = new Map<ScriptKey, RunMeta>();
  private runIdToKey = new Map<string, ScriptKey>();
  // Events that arrived before the `scripts.run` invoke resolved and let
  // us bind the runId to a key. A spawned child can emit its first bytes
  // before the IPC return reaches the renderer, so buffer here and flush
  // in start() once we know the runId. "started" events are dispatched
  // directly by handleEvent, so they never reach this buffer.
  private pendingByRunId = new Map<string, PostStartEvent[]>();
  private perKeySubs = new KeyedSubscribers<ScriptKey>();
  private worktreeSubs = new KeyedSubscribers<string>();
  private unsubscribers: Array<() => void> = [];
  private api: ScriptsApi;
  private warn: WarnFn;
  // Whether a removed-worktree notice is worth a toast even for a
  // worktree this store never saw a run in. True for this machine's
  // store (a renderer reload forgets runs the host still reaps), false
  // for a peer's, where the notice reaches every viewer and only the
  // ones that ran something there have anything to hear.
  private warnOnUnseenRemoval: boolean;

  constructor(api: ScriptsApi, warn: WarnFn, warnOnUnseenRemoval: boolean) {
    this.api = api;
    this.warn = warn;
    this.warnOnUnseenRemoval = warnOnUnseenRemoval;
  }

  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers.push(
      this.api.onEvent((event) => this.handleEvent(event)),
      this.api.onStoppedForRemovedWorktree((info) =>
        this.handleRemovedWorktree(info),
      ),
    );
  }

  async run(input: StartInput): Promise<void> {
    this.setMetaWithDeferred(input.key, input.worktreeId, input.slot);
    this.buffers.delete(input.key);

    this.setStateWithActivity(input.key, () => ({
      runId: null,
      status: "starting",
      hasOutput: false,
      interactive: true,
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
      const message = errorMessageOf(err);
      this.appendChunk(input.key, `\r\n\x1b[31m${message}\x1b[0m\r\n`);
      this.setStateWithActivity(input.key, (s) => ({
        ...s,
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

  // Console keystrokes and viewport size for a live run. Both are
  // fire-and-forget, and the guards here keep runs without a PTY (and
  // finished ones) from being written to at all.
  write(key: ScriptKey, data: string): void {
    const runId = this.liveInteractiveRunId(key);
    if (!runId) return;
    void this.api.write(runId, data).catch(() => {});
  }

  resize(key: ScriptKey, cols: number, rows: number): void {
    const runId = this.liveInteractiveRunId(key);
    if (!runId) return;
    void this.api.resize(runId, cols, rows).catch(() => {});
  }

  private liveInteractiveRunId(key: ScriptKey): string | null {
    const state = this.states.get(key);
    if (!state?.runId || !state.interactive) return null;
    return state.status === "running" ? state.runId : null;
  }

  clear(key: ScriptKey): void {
    const state = this.states.get(key);
    if (!state) return;
    if (state.status === "running" || state.status === "starting") return;
    if (state.runId) this.runIdToKey.delete(state.runId);
    this.states.delete(key);
    this.buffers.delete(key);
    this.meta.delete(key);
    this.notify(key);
  }

  // The run's output so far (capped, see MAX_OUTPUT_BYTES), for a
  // console that has just mounted and needs to catch up before it
  // follows subscribeOutput. Read both in the same tick and nothing is
  // missed or doubled.
  readOutput(key: ScriptKey): readonly string[] {
    return this.buffers.get(key)?.chunks ?? [];
  }

  subscribeOutput(key: ScriptKey, cb: (chunk: string) => void): () => void {
    return this.outputSubs.subscribe(key, cb);
  }

  // Called when a worktree is removed (delete / relocate / convert);
  // otherwise per-worktree state and runId mappings would leak across
  // worktrees that no longer exist on disk. Returns whether this store
  // held any run there.
  clearForWorktree(worktreeId: string): boolean {
    let touched = false;
    for (const [key, m] of this.meta) {
      if (m.worktreeId !== worktreeId) continue;
      const s = this.states.get(key);
      if (s?.runId) this.runIdToKey.delete(s.runId);
      this.states.delete(key);
      this.buffers.delete(key);
      this.meta.delete(key);
      this.notify(key);
      touched = true;
    }
    if (touched) this.notifyWorktree(worktreeId);
    return touched;
  }

  // Main reaped this worktree's scripts because it was removed outside
  // the app. Worth saying out loud rather than letting the user find
  // out from a dead localhost: they removed a worktree in a terminal,
  // and the visible consequence is a dev server going down somewhere
  // else. The run's own console can't carry the notice, since the row
  // it lives on disappears with the worktree.
  private handleRemovedWorktree(info: RemovedWorktreeScripts): void {
    const seen = this.clearForWorktree(info.worktreeId);
    if (!seen && !this.warnOnUnseenRemoval) return;
    this.warn(`${info.worktreeName} was removed outside the app`, {
      description:
        info.scriptCount === 1
          ? "Its running script was stopped."
          : `Its ${info.scriptCount} running scripts were stopped.`,
    });
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
    return this.perKeySubs.subscribe(key, cb);
  }

  subscribeWorktree(worktreeId: string, cb: () => void): () => void {
    return this.worktreeSubs.subscribe(worktreeId, cb);
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

  private notify(key: ScriptKey): void {
    this.perKeySubs.notify(key);
  }

  private notifyWorktree(worktreeId: string): void {
    this.worktreeSubs.notify(worktreeId);
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

  // Log one chunk and hand it to any mounted console. The snapshot only
  // changes for the run's first chunk.
  private appendChunk(key: ScriptKey, chunk: string): void {
    let log = this.buffers.get(key);
    if (!log) {
      log = { chunks: [], bytes: 0 };
      this.buffers.set(key, log);
    }
    log.chunks.push(chunk);
    log.bytes += chunk.length;
    if (log.bytes > MAX_OUTPUT_BYTES) {
      let drop = 0;
      while (log.bytes > MAX_OUTPUT_BYTES && drop < log.chunks.length - 1) {
        log.bytes -= log.chunks[drop]!.length;
        drop++;
      }
      log.chunks.splice(0, drop);
    }
    this.outputSubs.notify(key, chunk);
    this.setStateWithActivity(key, (s) =>
      s.hasOutput ? s : { ...s, hasOutput: true },
    );
  }

  private applyEvent(key: ScriptKey, event: PostStartEvent): void {
    switch (event.kind) {
      case "data":
        this.appendChunk(key, event.data);
        return;
      case "error":
        this.appendChunk(key, `\r\n\x1b[31m${event.data}\x1b[0m\r\n`);
        this.setStateWithActivity(key, (s) => ({ ...s, status: "errored" }));
        return;
      case "exit": {
        const m = this.meta.get(key);
        m?.exitDeferred?.resolve(event.code);
        if (m) this.meta.set(key, { ...m, exitDeferred: null });
        this.runIdToKey.delete(event.runId);
        this.appendChunk(key, exitSentinel(event.code));
        this.setStateWithActivity(key, (s) => ({
          ...s,
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
    this.buffers.delete(key);

    this.setStateWithActivity(key, () => ({
      runId: event.runId,
      status: "running",
      hasOutput: false,
      interactive: false,
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

function exitSentinel(code: number | null): string {
  // Dim divider so users can see where the run ended even if the
  // program's last line didn't end with a newline.
  if (code === null) return "\r\n\x1b[2m── stopped ──\x1b[0m\r\n";
  if (code === 0) return "\r\n\x1b[2m── done ──\x1b[0m\r\n";
  return `\r\n\x1b[31m── exit ${code} ──\x1b[0m\r\n`;
}

const warnToast: WarnFn = (title, options) => toast.warning(title, options);

// This machine's store. `start()` is called by the renderer entry point
// so subscription lifecycle has a single owner. Importing this module
// just constructs the singleton and attaches no IPC listener as a side
// effect.
export const scriptRuns = new ScriptRunsStore(
  window.api.scripts,
  warnToast,
  true,
);

// The store for any device: this machine's, or a peer's built on first
// use over that device's api (the same per-device api the remote
// registry hands every scoped page) and kept for the window's
// lifetime, like the api itself. A peer store starts draining the
// device's event channel at once: the first use is a scoped page or a
// sidebar row that wants the device's runs, so there is no earlier
// owner to hand the lifecycle to. The channel is a hub-transport
// subscription that rides the shared peerPush fan-out, so a store per
// device costs one registry entry each and no IPC listener.
const peerStores = new Map<string, ScriptRunsStore>();

export function scriptRunsFor(deviceId: string): ScriptRunsStore {
  if (deviceId === localDeviceId) return scriptRuns;
  let store = peerStores.get(deviceId);
  if (store === undefined) {
    store = new ScriptRunsStore(apiFor(deviceId).scripts, warnToast, false);
    store.start();
    peerStores.set(deviceId, store);
  }
  return store;
}
