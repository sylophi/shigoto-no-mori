// A device's script runs, in-flight and most recent, keyed by
// (projectId, worktreeId, slot), as an atom on the client's runtime
// (scriptRunsAtom): one per device, each draining the scripts:event
// pushes of its device (this machine's over its own link, a peer's out
// of the hub hop), and events route to the right record through each
// run id's binding (Binding). Worktree ids are path hashes
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
import { errorMessageOf } from "@shigomori/contracts/errors";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import type {
  ScriptActivityKind,
  ScriptRunState,
} from "@shigomori/ui/lib/scriptRun.ts";
import { assertNever } from "@shigomori/ui/lib/utils.ts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Stream from "effect/Stream";
import type { HostApi } from "@/lib/runtime/Api";
import { inputPieces } from "@/lib/terminalInput";
import {
  accountsLeftAtom,
  clientAtoms,
  deviceApi,
  heard,
  hostSessionAtom,
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

// Where a host run id stands here. `pending`: events heard before it
// is bound, as a spawned child's first bytes can beat `scripts.run`'s
// answer ("started" events bind at once, so never wait here).
// `attaching`: an attach or rejoin is out, its events waiting to be
// drained after the backlog, and `lost` once the list dropped it
// meanwhile, for the attach to end it as it lands. `bound`: its events
// go to the slot's record, which holds it as running. `ignored`: let go
// of while live, its events dropped until its exit.
type Attaching = {
  readonly kind: "attaching";
  events: PostStartEvent[];
  lost: boolean;
};
type Binding =
  | { readonly kind: "pending"; readonly events: PostStartEvent[] }
  | Attaching
  | { readonly kind: "bound"; readonly key: ScriptKey }
  | { readonly kind: "ignored" };

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

// What a console following a run's log is handed: the next chunk, or
// with `reset` the whole log again, which started over (resume).
type OutputUpdate = { readonly data: string; readonly reset: boolean };

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

export class ScriptRuns {
  // What the rows, consoles and the sidebar draw, mounted with the
  // atom that made this (scriptRunsAtom).
  readonly state = Atom.make(NO_RUNS);
  // Per-run output log, keyed like the states, mutated in place: a
  // render per PTY read would be the hot path. Consoles catch up from it
  // on mount and follow it through outputSubs.
  private buffers = new Map<ScriptKey, OutputLog>();
  private outputSubs = new KeyedSubscribers<ScriptKey, OutputUpdate>();
  private bindings = new Map<string, Binding>();
  // The runs the device's list named last (settle).
  private listed = new Set<string>();
  private registry: AtomRegistry.AtomRegistry;
  // The device's script calls, and what runs each as a Promise.
  private scripts: HostApi["scripts"];
  private runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  // Whether a removed-worktree notice is worth a toast even for a
  // worktree these runs never saw a run in. True for this machine's (a
  // renderer reload forgets runs the host still reaps), false for a
  // peer's, where the notice reaches every viewer and only the ones
  // that ran something there have anything to hear.
  private warnOnUnseenRemoval: boolean;
  private ends = 0;

  constructor(
    registry: AtomRegistry.AtomRegistry,
    scripts: HostApi["scripts"],
    runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
    warnOnUnseenRemoval: boolean,
  ) {
    this.registry = registry;
    this.scripts = scripts;
    this.runPromise = runPromise;
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
    // Nothing changes a starting record but a run taking the slot or its
    // worktree's removal, so another record here means this one is gone.
    const begun = this.current.states.get(input.key);

    let runId: string;
    try {
      const result = await input.runner();
      runId = result.runId;
    } catch (err) {
      if (this.current.states.get(input.key) !== begun) throw err;
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
    if (this.current.states.get(input.key) !== begun) {
      this.letGo(runId);
      return;
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
  // sends before the answer lands wait in its binding and are
  // drained after the backlog, so nothing is missed or doubled.
  // Resolves false only when the host could not be asked (refused, or
  // the device away), for the caller to ask again.
  async attach(run: RunningScript): Promise<boolean> {
    const key = scriptKey(run.projectId, run.worktreeId, run.slot);
    const held = this.current.states.get(key);
    const was = this.bindings.get(run.runId);
    if (held?.runId === run.runId || was?.kind === "attaching") return true;
    if (held?.status === "starting") return true;
    const attaching: Attaching = {
      kind: "attaching",
      events: was?.kind === "pending" ? was.events : [],
      lost: false,
    };
    this.bindings.set(run.runId, attaching);
    try {
      const joined = await this.runPromise(
        this.scripts.attach({ runId: run.runId }),
      ).catch(() => undefined);
      if (joined === undefined) {
        this.bindings.set(
          run.runId,
          was?.kind === "ignored"
            ? was
            : { kind: "pending", events: attaching.events },
        );
        return false;
      }
      if (joined === null) {
        this.bindings.delete(run.runId);
        return true;
      }
      // This connection heard the run already (another window on it
      // attached, or this one started it before a reload), so what it
      // buffered is in the backlog too.
      if (joined.streaming) attaching.events = [];
      const now = this.current.states.get(key);
      if (now?.status === "starting" || now?.status === "running") {
        // The slot was taken by a run started here meanwhile. The host
        // keeps sending this one, which nothing here will show.
        this.letGo(run.runId);
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
    } finally {
      if (attaching.lost) this.drop(run.runId);
    }
  }

  // A new session to the device (hostSessionAtom). The host sends a
  // run's events to the session that started or attached it, which is
  // gone, so each run held as running is attached again on this one,
  // its log and its consoles starting over from the host's backlog. One
  // the host no longer has, or that could not be asked about, ends as
  // the list drops it (settle).
  resume(): void {
    for (const [key, state] of this.current.states) {
      if (state.status === "running" && state.runId !== null) {
        void this.rejoin(key, state.runId);
      }
    }
  }

  // The run's events wait while the attach is out, as an attach's do,
  // and are drained after the backlog. A slot that let go of the run
  // meanwhile, or a later rejoin, replaced the binding.
  private async rejoin(key: ScriptKey, runId: string): Promise<void> {
    const attaching: Attaching = { kind: "attaching", events: [], lost: false };
    this.bindings.set(runId, attaching);
    const joined = await this.runPromise(this.scripts.attach({ runId })).catch(
      () => null,
    );
    if (this.bindings.get(runId) === attaching) {
      if (joined !== null) {
        // This connection heard the run already (another window on it
        // attached first), so what it buffered is in the backlog too.
        if (joined.streaming) attaching.events = [];
        const { output } = joined;
        this.buffers.set(key, { chunks: [output], bytes: output.length });
        this.outputSubs.notify(key, { data: output, reset: true });
      }
      this.bindRunIdAndDrain(key, runId);
    }
    if (attaching.lost) this.drop(runId);
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
    return (await this.runPromise(this.scripts.cancel({ runId: run.runId })))
      .cancelled;
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
      ({ cancelled } = await this.runPromise(
        this.scripts.cancel({ runId: state.runId }),
      ));
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
  // their consoles stop reading running, and lets go of the events
  // buffered for one never bound here (another window's, whose events
  // a peer's session brings every window). Only runs the list named
  // before: it lags a start here by the view's next value.
  settle(runs: readonly RunningScript[]): void {
    const now = new Set(runs.map((run) => run.runId));
    for (const runId of this.listed) {
      if (!now.has(runId)) this.lost(runId);
    }
    this.listed = now;
  }

  private lost(runId: string): void {
    setTimeout(() => this.drop(runId), LOST_GRACE_MS);
  }

  // A run the host no longer has, once its grace is up.
  private drop(runId: string): void {
    const binding = this.bindings.get(runId);
    if (binding === undefined) return;
    if (binding.kind === "attaching") {
      // The attach out for it may yet bind it, and ends it as it lands.
      binding.lost = true;
      return;
    }
    if (binding.kind !== "bound") {
      this.bindings.delete(runId);
      return;
    }
    this.applyEvent(binding.key, { runId, kind: "exit", code: null });
    // Its exit, should it still come, would wait for a binding forever.
    this.bindings.set(runId, { kind: "ignored" });
  }

  // A run no slot here holds any more, while it may still be live. Its
  // binding is dropped if its exit came already.
  private letGo(runId: string): void {
    const binding = this.bindings.get(runId);
    if (
      binding !== undefined &&
      "events" in binding &&
      binding.events.some((event) => event.kind === "exit")
    ) {
      this.bindings.delete(runId);
      return;
    }
    this.bindings.set(runId, { kind: "ignored" });
  }

  // Console keystrokes and viewport size for a live run. Both are
  // fire-and-forget, and the guards here keep runs without a PTY (and
  // finished ones) from being written to at all.
  write(key: ScriptKey, data: string): void {
    const runId = this.liveInteractiveRunId(key);
    if (!runId) return;
    for (const piece of inputPieces(data)) {
      void this.runPromise(this.scripts.write({ runId, data: piece })).catch(
        () => {},
      );
    }
  }

  resize(key: ScriptKey, cols: number, rows: number): void {
    const runId = this.liveInteractiveRunId(key);
    if (!runId) return;
    void this.runPromise(this.scripts.resize({ runId, cols, rows })).catch(
      () => {},
    );
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

  subscribeOutput(
    key: ScriptKey,
    cb: (update: OutputUpdate) => void,
  ): () => void {
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

  // Drops everything held for the slot, letting go of a run still live.
  private forget(key: ScriptKey): void {
    const { states, meta } = this.current;
    const state = states.get(key);
    if (state?.status === "running" && state.runId) this.letGo(state.runId);
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
    toast.warning(`${info.worktreeName} was deleted outside the app`, {
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
    this.outputSubs.notify(key, { data: chunk, reset: false });
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
        // Its exit follows, which ends the run.
        this.appendChunk(key, scriptErrorLine(event.data));
        return;
      case "exit": {
        const m = this.current.meta.get(key);
        // A run the user stopped exits unclean by definition, and the
        // console they stopped it from already says so.
        const stopped = this.current.states.get(key)?.cancelling === true;
        this.bindings.delete(event.runId);
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

  // A new run takes the slot: let go of the previous run, drop its
  // output, and start the snapshot over from EMPTY_STATE.
  private begin(
    key: ScriptKey,
    worktreeId: string,
    slot: ScriptSlot,
    init: Pick<ScriptRunState, "runId" | "status" | "interactive">,
  ): void {
    const { states, meta } = this.current;
    const prev = states.get(key);
    if (prev?.status === "running" && prev.runId) this.letGo(prev.runId);
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
    const was = this.bindings.get(runId);
    this.bindings.set(runId, { kind: "bound", key });
    if (was !== undefined && "events" in was) {
      for (const queued of was.events) this.applyEvent(key, queued);
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
    const binding = this.bindings.get(event.runId);
    if (binding === undefined) {
      this.bindings.set(event.runId, { kind: "pending", events: [event] });
      return;
    }
    if (binding.kind === "bound") {
      this.applyEvent(binding.key, event);
      return;
    }
    if (binding.kind === "ignored") {
      if (event.kind === "exit") this.bindings.delete(event.runId);
      return;
    }
    if (binding.events.length >= MAX_PENDING_CHUNKS) binding.events.shift();
    binding.events.push(event);
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
// (accountsLeftAtom): a run state and a scrollback are the peer's. A
// new session to the device's host keeps them, and attaches again to
// the runs they hold (resume).
export const scriptRunsAtom = Atom.family((deviceId: string) =>
  Atom.keepAlive(
    clientAtoms.atom((get) =>
      Effect.gen(function* () {
        const localDeviceId = get(localDeviceIdAtom);
        const local = deviceId === localDeviceId;
        if (!local) get(accountsLeftAtom);
        const api = yield* deviceApi(deviceId, localDeviceId);
        // Each call runs on the atom's scope, so one still in flight
        // ends with it.
        const run = yield* FiberSet.makeRuntimePromise<never>();
        const runs = new ScriptRuns(get.registry, api.scripts, run, local);
        get.mount(runs.state);
        get.subscribe(hostSessionAtom(deviceId), () => runs.resume());
        const pushes = <K extends "event" | "stoppedForRemovedWorktree">(
          key: K,
        ) => api.pushes(scriptsContract, key);
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
