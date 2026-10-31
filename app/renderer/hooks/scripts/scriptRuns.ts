// A device's script runs, in-flight and most recent, keyed by
// (projectId, worktreeId, slot), as an atom on the client's runtime
// (scriptRunsAtom): one per device, each draining the scripts:event
// pushes of its device (this machine's over its own link, a peer's out
// of the hub hop), and events route to the right record via a
// runId→key index built when a run starts. Worktree ids are path hashes
// that can collide across the owner's machines, so a run's key is only
// unambiguous inside its device's runs.
//
// React reads them through hooks/scripts/useScriptRuns.ts, which
// resolves the device from the host scope, and the state a row draws
// is the controller's `state` atom. They survive navigation but not a
// renderer reload (in memory only).
//
// The state is immutable: every transition replaces the record with a
// new object, and the maps holding them, since a reader picks its
// record out by identity.
import {
  type RemovedWorktreeScripts,
  type RunningScript,
  type ScriptEvent,
  scriptErrorLine,
} from "@shigomori/contracts/schemas";
import { callOf } from "@shigomori/contracts/contract";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import type {
  ScriptActivityKind,
  ScriptRunState,
} from "@shigomori/ui/lib/scriptRun.ts";
import { assertNever } from "@shigomori/ui/lib/utils.ts";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Stream from "effect/Stream";
import {
  accountsLeftAtom,
  clientAtoms,
  heard,
  hostCalls,
  hostPushes,
  localDeviceIdAtom,
  valueNow,
} from "@/lib/runtime/atoms";
import { toast } from "@/lib/toast";
import { KeyedSubscribers } from "@/store/keyedSubscribers";
import { scriptKey, type ScriptKey, type ScriptSlot } from "@/store/scriptSlot";

// Output kept per run for replay when a console mounts, in bytes: more
// than the terminal's own scrollback can show, small enough that the
// replay parses in a moment and that a window's worth of finished runs
// stays cheap to keep around.
const MAX_OUTPUT_BYTES = 1024 * 1024;

// Cap per-runId pre-bind buffers. The legitimate buffering window is one
// IPC round-trip (events arriving before `scripts.run` resolves), so a
// bucket this deep means the runId will never bind, e.g. a script that
// was already streaming when the renderer reloaded and rebuilt this
// store. Without a cap those orphaned buckets grow for as long as the
// script keeps producing output.
const MAX_PENDING_CHUNKS = 500;

// How long a run the host no longer has keeps waiting for its exit. The
// list and the events are separate streams, so a healthy exit, with
// its last output and its code, can trail the list that dropped it.
const LOST_GRACE_MS = 5_000;

// "started" is handled separately by handleEvent (which binds the runId
// before delegating to applyEvent). Narrowing the post-start union lets
// applyEvent's switch stay exhaustive with assertNever as the safety net.
type PostStartEvent = Exclude<ScriptEvent, { kind: "started" }>;

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
  // Which end this was, in this window's order of ends (scriptRuns'
  // `ends`), so a failure is newer than a look by order, not by clock.
  endOrder?: number;
}

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

// What a reader draws: each slot's record, which worktree and kind of
// slot it is, and how many runs had ended when each worktree's page was
// last left (a failure since then is news, activityOf).
type RunsState = {
  readonly states: ReadonlyMap<ScriptKey, ScriptRunState>;
  readonly meta: ReadonlyMap<ScriptKey, RunMeta>;
  readonly seenThrough: ReadonlyMap<string, number>;
};

const NO_RUNS: RunsState = {
  states: new Map(),
  meta: new Map(),
  seenThrough: new Map(),
};

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V) =>
  new Map(map).set(key, value);

const withoutEntry = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

// The host calls a device's runs make, over its link.
type ScriptCalls = {
  readonly attach: (input: {
    runId: string;
  }) => Promise<{ streaming: boolean; output: string } | null>;
  readonly cancel: (input: {
    runId: string;
  }) => Promise<{ cancelled: boolean }>;
  readonly write: (input: { runId: string; data: string }) => Promise<void>;
  readonly resize: (input: {
    runId: string;
    cols: number;
    rows: number;
  }) => Promise<void>;
};

export class ScriptRuns {
  // What the rows, consoles and the sidebar draw, mounted with the
  // atom that made this (scriptRunsAtom).
  readonly state = Atom.make(NO_RUNS);
  // Per-run output log, keyed like the states, mutated in place: a
  // render per PTY read would be the hot path. Consoles catch up from it
  // on mount and follow it through outputSubs.
  private buffers = new Map<ScriptKey, OutputLog>();
  private outputSubs = new KeyedSubscribers<ScriptKey, string>();
  private runIdToKey = new Map<string, ScriptKey>();
  // Events that arrived before the `scripts.run` invoke resolved and let
  // us bind the runId to a key. A spawned child can emit its first bytes
  // before the IPC return reaches the renderer, so buffer here and flush
  // in start() once we know the runId. "started" events are dispatched
  // directly by handleEvent, so they never reach this buffer.
  private pendingByRunId = new Map<string, PostStartEvent[]>();
  // Runs an attach is in flight for, so a slot asked again while the
  // first answer is on its way does not attach twice.
  private attaching = new Set<string>();
  // Runs attached to and then let go (attach), whose events the host
  // still sends until they exit.
  private ignored = new Set<string>();
  // The runs the device's list named last (settle).
  private listed = new Set<string>();
  private registry: AtomRegistry.AtomRegistry;
  private api: ScriptCalls;
  // Whether a removed-worktree notice is worth a toast even for a
  // worktree these runs never saw a run in. True for this machine's (a
  // renderer reload forgets runs the host still reaps), false for a
  // peer's, where the notice reaches every viewer and only the ones
  // that ran something there have anything to hear.
  private warnOnUnseenRemoval: boolean;
  private ends = 0;

  constructor(
    registry: AtomRegistry.AtomRegistry,
    api: ScriptCalls,
    warnOnUnseenRemoval: boolean,
  ) {
    this.registry = registry;
    this.api = api;
    this.warnOnUnseenRemoval = warnOnUnseenRemoval;
  }

  private get current(): RunsState {
    return this.registry.get(this.state);
  }

  private publish(next: RunsState): void {
    this.registry.set(this.state, next);
  }

  async run(input: StartInput): Promise<void> {
    this.begin(input.key, input.worktreeId, input.slot, {
      runId: null,
      status: "starting",
      interactive: true,
    });

    let runId: string;
    try {
      const result = await input.runner();
      runId = result.runId;
    } catch (err) {
      const message = errorMessageOf(err);
      this.appendChunk(input.key, scriptErrorLine(message));
      this.setStateWithActivity(input.key, (s) => ({
        ...s,
        status: "errored",
        endedAt: Date.now(),
      }));
      this.ended(input.key);
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

  // Takes up a run the host lists that this store does not hold (one
  // another window or device started, or this window before a reload):
  // its output so far, then its events as they come, so its console,
  // status and Stop work as for a run started here. Events the host
  // sends before the answer lands wait in the pre-bind buffer and are
  // drained after the backlog, so nothing is missed or doubled.
  // Resolves false only when the host could not be asked (refused, or
  // the device away), for the caller to ask again.
  async attach(run: RunningScript): Promise<boolean> {
    const key = scriptKey(run.projectId, run.worktreeId, run.slot);
    const held = this.current.states.get(key);
    if (held?.runId === run.runId || this.attaching.has(run.runId)) {
      return true;
    }
    if (held?.status === "starting") return true;
    this.attaching.add(run.runId);
    try {
      const joined = await this.api.attach({ runId: run.runId });
      if (joined === null) return true;
      // This connection heard the run already (another window on it
      // attached, or this one started it before a reload), so what it
      // buffered is in the backlog too.
      if (joined.streaming) this.pendingByRunId.delete(run.runId);
      const now = this.current.states.get(key);
      if (now?.status === "starting" || now?.status === "running") {
        // The slot was taken by a run started here meanwhile. The host
        // keeps sending this one, which nothing here will show.
        this.ignored.add(run.runId);
        this.pendingByRunId.delete(run.runId);
        return true;
      }
      this.begin(key, run.worktreeId, run.slot, {
        runId: run.runId,
        status: "running",
        interactive: run.interactive,
      });
      this.setStateWithActivity(key, (s) => ({
        ...s,
        startedAt: run.startedAt,
      }));
      if (joined.output !== "") this.appendChunk(key, joined.output);
      this.bindRunIdAndDrain(key, run.runId);
      return true;
    } catch {
      return false;
    } finally {
      this.attaching.delete(run.runId);
    }
  }

  // Stops a run the host lists, whether these runs hold it (its
  // console then reads "Stopping…" until the exit) or not (one another
  // window or device started, stopped by its id).
  // Resolves whether the host stopped it.
  async stopRun(run: RunningScript): Promise<boolean> {
    const key = scriptKey(run.projectId, run.worktreeId, run.slot);
    if (this.current.states.get(key)?.runId === run.runId) {
      return this.cancel(key);
    }
    return (await this.api.cancel({ runId: run.runId })).cancelled;
  }

  // Resolves whether the host stopped the run.
  async cancel(key: ScriptKey): Promise<boolean> {
    const state = this.current.states.get(key);
    if (!state || !state.runId) return false;
    if (state.status !== "running" && state.status !== "starting") {
      return false;
    }
    this.setStateWithActivity(key, (s) =>
      s.cancelling ? s : { ...s, cancelling: true },
    );
    let cancelled: boolean;
    try {
      ({ cancelled } = await this.api.cancel({ runId: state.runId }));
    } catch {
      // The exit that follows a real stop is what clears the flag, so a
      // stop that could not be asked must clear it here or the button
      // reads "Stopping…" for good.
      this.setStateWithActivity(key, (s) =>
        s.status === "running" || s.status === "starting"
          ? { ...s, cancelling: false }
          : s,
      );
      return false;
    }
    // A run the host no longer has: it ended where its exit could not
    // reach here.
    if (!cancelled) this.lost(state.runId);
    return cancelled;
  }

  // Ends the runs that left the device's list with no exit heard here
  // (its host restarted, or the session dropped as the run ended), so
  // their consoles stop reading running. Only runs the list named
  // before: it lags a start here by the view's next value.
  settle(runs: readonly RunningScript[]): void {
    const now = new Set(runs.map((run) => run.runId));
    for (const runId of this.listed) {
      if (!now.has(runId)) this.lost(runId);
    }
    this.listed = now;
  }

  private lost(runId: string): void {
    setTimeout(() => {
      const key = this.runIdToKey.get(runId);
      if (!key || this.current.states.get(key)?.status !== "running") return;
      // Its exit, should it still come, would wait for a binding forever.
      this.ignored.add(runId);
      this.applyEvent(key, { runId, kind: "exit", code: null });
    }, LOST_GRACE_MS);
  }

  // Console keystrokes and viewport size for a live run. Both are
  // fire-and-forget, and the guards here keep runs without a PTY (and
  // finished ones) from being written to at all.
  write(key: ScriptKey, data: string): void {
    const runId = this.liveInteractiveRunId(key);
    if (!runId) return;
    void this.api.write({ runId, data }).catch(() => {});
  }

  resize(key: ScriptKey, cols: number, rows: number): void {
    const runId = this.liveInteractiveRunId(key);
    if (!runId) return;
    void this.api.resize({ runId, cols, rows }).catch(() => {});
  }

  private liveInteractiveRunId(key: ScriptKey): string | null {
    const state = this.current.states.get(key);
    if (!state?.runId || !state.interactive) return null;
    return state.status === "running" ? state.runId : null;
  }

  clear(key: ScriptKey): void {
    const state = this.current.states.get(key);
    if (!state) return;
    if (state.status === "running" || state.status === "starting") return;
    this.forget(key);
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

  // Called when a worktree is removed (delete / relocate / convert), so
  // per-worktree state and runId mappings don't leak across worktrees
  // that no longer exist on disk. Returns whether these runs
  // held any run there.
  clearForWorktree(worktreeId: string): boolean {
    const { seenThrough } = this.current;
    if (seenThrough.has(worktreeId)) {
      this.publish({
        ...this.current,
        seenThrough: withoutEntry(seenThrough, worktreeId),
      });
    }
    let touched = false;
    for (const [key, m] of this.current.meta) {
      if (m.worktreeId !== worktreeId) continue;
      this.forget(key);
      touched = true;
    }
    return touched;
  }

  // Drops everything held for the slot, its run's id binding included.
  private forget(key: ScriptKey): void {
    const { states, meta } = this.current;
    const state = states.get(key);
    if (state?.runId) this.runIdToKey.delete(state.runId);
    this.buffers.delete(key);
    this.publish({
      ...this.current,
      states: withoutEntry(states, key),
      meta: withoutEntry(meta, key),
    });
  }

  // Main reaped this worktree's scripts because it was removed outside
  // the app. Worth saying out loud rather than letting the user find
  // out from a dead localhost: they removed a worktree in a terminal,
  // and the visible consequence is a dev server going down somewhere
  // else. The run's own console can't carry the notice, since the row
  // it lives on disappears with the worktree.
  handleRemovedWorktree(info: RemovedWorktreeScripts): void {
    const seen = this.clearForWorktree(info.worktreeId);
    if (!seen && !this.warnOnUnseenRemoval) return;
    toast.warning(`${info.worktreeName} was removed outside the app`, {
      description:
        info.scriptCount === 1
          ? "Its running script was stopped."
          : `Its ${info.scriptCount} running scripts were stopped.`,
    });
  }

  // The worktree's page was left (or is being left): every failure so
  // far has had its chance to be seen.
  markSeen(worktreeId: string): void {
    this.publish({
      ...this.current,
      seenThrough: withEntry(this.current.seenThrough, worktreeId, this.ends),
    });
  }
  private ended(key: ScriptKey): void {
    const m = this.current.meta.get(key);
    if (!m) return;
    this.ends += 1;
    this.publish({
      ...this.current,
      meta: withEntry(this.current.meta, key, { ...m, endOrder: this.ends }),
    });
  }

  private setStateWithActivity(
    key: ScriptKey,
    update: (prev: ScriptRunState) => ScriptRunState,
  ): void {
    const { states } = this.current;
    const prev = states.get(key) ?? EMPTY_STATE;
    const next = update(prev);
    if (next === prev) return;
    this.publish({ ...this.current, states: withEntry(states, key, next) });
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
        log.bytes -= log.chunks[drop]?.length ?? 0;
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
        this.appendChunk(key, scriptErrorLine(event.data));
        this.setStateWithActivity(key, (s) => ({ ...s, status: "errored" }));
        return;
      case "exit": {
        const m = this.current.meta.get(key);
        // A run the user stopped exits unclean by definition, and the
        // console they stopped it from already says so.
        const stopped = this.current.states.get(key)?.cancelling === true;
        this.runIdToKey.delete(event.runId);
        this.appendChunk(key, exitSentinel(event.code));
        this.setStateWithActivity(key, (s) => ({
          ...s,
          exitCode: event.code,
          status: "exited",
          endedAt: Date.now(),
          cancelling: false,
        }));
        this.ended(key);
        if (event.code !== 0 && m && !stopped) {
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
  // a toast on top. Package scripts are user-initiated, and their console
  // is already visible.
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
    toast.warning(`${label} didn't complete cleanly`, {
      description:
        exitCode === null
          ? "See the script console for details."
          : `Exited with code ${exitCode}.`,
    });
  }

  // A new run takes the slot: unbind the previous run's id, drop its
  // output, and start the snapshot over from EMPTY_STATE.
  private begin(
    key: ScriptKey,
    worktreeId: string,
    slot: ScriptSlot,
    init: Pick<ScriptRunState, "runId" | "status" | "interactive">,
  ): void {
    const { states, meta } = this.current;
    const prev = states.get(key);
    if (prev?.runId) this.runIdToKey.delete(prev.runId);
    this.publish({
      ...this.current,
      meta: withEntry(meta, key, {
        worktreeId,
        slotKind: deriveSlotKind(slot),
      }),
    });
    this.buffers.delete(key);
    this.setStateWithActivity(key, () => ({
      ...EMPTY_STATE,
      ...init,
      startedAt: Date.now(),
    }));
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
    this.begin(key, event.worktreeId, event.slot, {
      runId: event.runId,
      status: "running",
      interactive: false,
    });

    this.bindRunIdAndDrain(key, event.runId);
  }

  handleEvent(event: ScriptEvent): void {
    if (event.kind === "started") {
      this.bindStarted(event);
      return;
    }
    const key = this.runIdToKey.get(event.runId);
    if (key) {
      this.applyEvent(key, event);
      return;
    }
    if (this.ignored.has(event.runId)) {
      if (event.kind === "exit") this.ignored.delete(event.runId);
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

// Highest-priority active slot for the worktree, or null if nothing is
// running. Teardown trumps setup trumps package because it's the most
// consequential state to surface in the sidebar. With nothing running,
// an unseen failure (a nonzero exit since markSeen, so not a stop).
export function activityOf(
  { states, meta, seenThrough }: RunsState,
  worktreeId: string,
): ScriptActivityKind | null {
  let hasSetup = false;
  let hasPackage = false;
  let hasUnseenFailure = false;
  const seen = seenThrough.get(worktreeId) ?? 0;
  for (const [key, m] of meta) {
    if (m.worktreeId !== worktreeId) continue;
    const s = states.get(key);
    if (!s) continue;
    if (s.status !== "starting" && s.status !== "running") {
      if (s.exitCode && (m.endOrder ?? 0) > seen) hasUnseenFailure = true;
      continue;
    }
    // Release is conceptually like teardown, the highest priority tier.
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
  if (hasUnseenFailure) return "failed";
  return null;
}

// A device's runs. This machine's the boot mounts where it has a host,
// so a setup failure or a removed worktree's notice is heard with no
// page open. A peer's start on first use (a scoped page, or a sidebar
// row that wants the device's runs) and are kept for the page's
// lifetime, until the account they belonged to is left
// (accountsLeftAtom): a run state and a scrollback are the peer's.
export const scriptRunsAtom = Atom.family((deviceId: string) =>
  Atom.keepAlive(
    clientAtoms.atom((get) =>
      Effect.gen(function* () {
        const localDeviceId = get(localDeviceIdAtom);
        const local = deviceId === localDeviceId;
        if (!local) get(accountsLeftAtom);
        const call = yield* hostCalls(deviceId, localDeviceId);
        const runs = new ScriptRuns(
          get.registry,
          {
            attach: (input) => call(callOf(scriptsContract, "attach"), input),
            cancel: (input) => call(callOf(scriptsContract, "cancel"), input),
            write: (input) => call(callOf(scriptsContract, "write"), input),
            resize: (input) => call(callOf(scriptsContract, "resize"), input),
          },
          local,
        );
        get.mount(runs.state);
        const pushes = <K extends "event" | "stoppedForRemovedWorktree">(
          key: K,
        ) => hostPushes(deviceId, localDeviceId, callOf(scriptsContract, key));
        yield* Stream.runForEach(pushes("event"), (event) =>
          heard("script event", () => runs.handleEvent(event)),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Stream.runForEach(pushes("stoppedForRemovedWorktree"), (info) =>
          heard("removed worktree's scripts", () =>
            runs.handleRemovedWorktree(info),
          ),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        return runs;
      }),
    ),
  ),
);

// A device's runs, for a caller outside React (the boot, a mutation).
export function scriptRunsOf(
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
): ScriptRuns {
  return valueNow(registry, scriptRunsAtom(deviceId));
}
