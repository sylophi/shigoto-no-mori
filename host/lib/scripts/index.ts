// Spawn per-project scripts under a PTY and stream their terminal
// output to the renderer, which feeds keystrokes and window-size changes
// back through writeToScript / resizeScript. Each script runs in its
// own session so we can kill the entire tree of children (dev servers,
// watchers, compilers the user's command spawns), not just the wrapping
// shell.
//
// The spawn/signal mechanics live in ./process.ts. This file only
// runs the SIGTERM -> grace -> SIGKILL escalation over them.
//
// On app quit (see index.ts) we kill every running script the same way
// before letting Electron exit, so a Cmd-Q never orphans `npm run dev`.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type Cause,
  Deferred,
  Effect,
  Fiber,
  Option,
  Queue,
  type Scope,
  Stream,
} from "effect";
import { errorMessageOf } from "@shared/errors";
import { containedSync } from "@shared/util/contained";
import { hostAttempt } from "@host/runtime";
import { stopMirrorsForWorktree } from "@host/mirror/registry";
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
// worktree row (or by a lifecycle) may run a while before (or without)
// anyone opening the console, so the default should suit a log.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
// PTYs hand output over in many small reads (a TUI redraw is several, a
// keystroke echo is one byte) and each event costs an IPC hop, a schema
// parse and a render, so reads that land within a frame go out as one
// chunk. The byte ceiling keeps a firehose from pooling for the whole
// frame.
export const OUTPUT_FLUSH_MS = 16;
export const OUTPUT_FLUSH_BYTES = 64 * 1024;

// What a run's output stream carries, in the order it happened. The PTY
// is one ordered byte stream (stdout and stderr share the terminal), so
// `data` reads concatenate without changing anything xterm renders. The
// other kinds are emitted by us, and each one closes the batch in front
// of it so it lands after the output that preceded it: a kill's notice,
// a PTY read error, the exit.
export type ScriptOutput =
  | { kind: "data"; data: string }
  | { kind: "notice"; data: string }
  | { kind: "error"; data: string }
  | { kind: "exit"; code: number | null };

// A batch's window closing: the timer a batch starts offers this into
// the same queue, so the window closes in order with the output around
// it. Only the batch that started it honors it (`batch` is its number);
// a tick that outlived its batch (closed early by the byte cap or an
// event) is dropped.
type OutputTick = { kind: "tick"; batch: number };

export type ScriptOutputQueue = Queue.Queue<
  ScriptOutput | OutputTick,
  Cause.Done
>;

// One frame's output, then the event that closed it early, if any.
export interface OutputBatch {
  data: string;
  closedBy: ScriptOutput | null;
}

export const makeScriptOutputQueue = (): ScriptOutputQueue =>
  Effect.runSync(Queue.unbounded<ScriptOutput | OutputTick, Cause.Done>());

// The batching rule as a Stream over a run's output queue: a read opens
// a batch, which goes out 16 ms after that read, or the moment it holds
// 64 KiB, or the moment one of our own events arrives, whichever is
// first; an idle run holds no timer. Stream.groupedWithin would count
// elements rather than bytes and flush on a fixed tick that runs while
// the script is idle, so the window is this pull instead: the timer is a
// child fiber that offers a tick into the queue, which means no take is
// ever interrupted (an interrupted take could lose the read it had just
// taken) and the window closes in order with the reads around it. The
// stream ends when the queue does, after the exit. Exported for the
// scripts check, which drives it under TestClock.
export function batchScriptOutput(
  events: ScriptOutputQueue,
): Stream.Stream<OutputBatch> {
  let opened = 0;
  // One take per burst: everything queued is drained at once and handed
  // out from here, so a firehose of reads costs one fiber wake per
  // burst rather than one per read. The drained events keep their
  // order, and a burst that spans a batch boundary carries over.
  let drained: ReadonlyArray<ScriptOutput | OutputTick> = [];
  let handed = 0;
  const nextEvent: Effect.Effect<ScriptOutput | OutputTick, Cause.Done> =
    Effect.suspend(() => {
      if (handed < drained.length) {
        return Effect.succeed(drained[handed++] as ScriptOutput | OutputTick);
      }
      return Queue.takeAll(events).pipe(
        Effect.map((items) => {
          drained = items;
          handed = 1;
          return items[0];
        }),
      );
    });
  const nextBatch = Effect.gen(function* () {
    let first = yield* nextEvent;
    while (first.kind === "tick") first = yield* nextEvent;
    if (first.kind !== "data") {
      return [{ data: "", closedBy: first }] as const;
    }
    const batch: OutputBatch = { data: first.data, closedBy: null };
    if (batch.data.length >= OUTPUT_FLUSH_BYTES) return [batch] as const;
    opened += 1;
    const id = opened;
    const timer = yield* Effect.sleep(OUTPUT_FLUSH_MS).pipe(
      Effect.andThen(Queue.offer(events, { kind: "tick", batch: id })),
      Effect.forkChild,
    );
    while (batch.data.length < OUTPUT_FLUSH_BYTES) {
      // Done here is the queue ending without an exit in front of it
      // (the check's teardown): the batch goes out, and the next pull
      // ends the stream.
      const next = yield* nextEvent.pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (next === null) break;
      if (next.kind === "tick") {
        if (next.batch === id) break;
        continue;
      }
      if (next.kind !== "data") {
        batch.closedBy = next;
        break;
      }
      batch.data += next.data;
    }
    yield* Fiber.interrupt(timer);
    return [batch] as const;
  });
  return Stream.fromPull(Effect.succeed(nextBatch));
}

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
  cancelling: boolean;
  // Completed once the exit event has gone out: the run has exited.
  done: Deferred.Deferred<void>;
  // The run's output stream (batchScriptOutput). Everything the run
  // emits goes through it, so it all reaches the renderer in order.
  output: ScriptOutputQueue;
}

const hasExited = (record: RunRecord): boolean =>
  Deferred.isDoneUnsafe(record.done);

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
// must hold until the LAST one finishes. With a plain Set, whichever
// finally ran first would drop the other's still-needed mark.
const inflightDeleteCounts = new Map<string, number>();
const inflightProjectDeleteIds = new Set<string>();
let shuttingDown = false;

// The sync pair, for the flows that mark a whole list up front and clear
// it in their own finally (nuke, the data-folder move). Every mark must
// be paired with exactly one clear.
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

// The mark as a scoped resource: held from the acquire to the close of
// the scope it is acquired in, however that scope ends (success, a
// failure, an interruption). The acquire refuses a worktree another
// mutation holds, in the same step as it marks, so no second mutation
// can slip in between the check and the mark.
function deleteMark(
  worktreeId: string,
  busyMessage: string,
): Effect.Effect<void, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.suspend(() =>
      inflightDeleteCounts.has(worktreeId)
        ? Effect.fail(new Error(busyMessage))
        : Effect.sync(() => markDeleteInflight(worktreeId)),
    ),
    () => Effect.sync(() => clearDeleteInflight(worktreeId)),
  );
}

// The one place the tombstone protocol is spelled out: refuse a
// concurrent mutation of the same worktree, mark the id so a still-
// running create lifecycle can't spawn steps into a directory that is
// vanishing or moving, reap app-spawned scripts before the mutation
// (a dev server would otherwise outlive its worktree or keep running
// in the old path), stop the mirrors rooted in it after the mutation
// (a session would otherwise sit halted on a root that is gone or
// moved, with the peer still calling its worktree mirrored), and
// always clear the mark. The mirrors go AFTER, not before: the CLI may
// refuse the mutation (a dirty tree without --force), and a mirror
// stopped ahead of a refusal cannot be started again while the branch
// is still checked out here. The engine is two-way safe, so the gap
// between the root vanishing and the stop propagates nothing. Callers
// supply the busy message because the operations differ (removed vs
// moved).
export function withDeleteInflight<T>(
  worktreeId: string,
  busyMessage: string,
  run: () => Promise<T>,
): Promise<T> {
  // The default runtime, like runKill below says.
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* deleteMark(worktreeId, busyMessage);
        yield* hostAttempt(() => killScriptsForWorktree(worktreeId));
        const result = yield* hostAttempt(run);
        yield* hostAttempt(() => stopMirrorsForWorktree(worktreeId));
        return result;
      }),
    ),
  );
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
// of each consumer patching the count locally. Returns the unregister,
// for a contributor that goes away before the app does.
const inflightContributors = new Set<() => number>();

export function registerInflightContributor(count: () => number): () => void {
  // A wrapper per registration, so registering one function twice
  // counts it twice and each unregister drops only its own.
  const entry = () => count();
  inflightContributors.add(entry);
  return () => {
    inflightContributors.delete(entry);
  };
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
    if (hasExited(record)) continue;
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

// The worktrees with a live app-started script, by id: what the
// auto-pull paths treat as busy.
export function runningScriptWorktreeIds(): Set<string> {
  return new Set(getRunningScriptWorktrees().map((entry) => entry.worktreeId));
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

// Whether the run's exit went out within `ms`. The wait is interrupted
// at the deadline, so nothing is left pending behind a timed-out one.
function exitedWithin(record: RunRecord, ms: number): Effect.Effect<boolean> {
  return Deferred.await(record.done).pipe(
    Effect.timeoutOption(ms),
    Effect.map(Option.isSome),
  );
}

interface KillOptions {
  graceMs?: number;
  reason?: string;
}

const killRecord = Effect.fnUntraced(function* (
  record: RunRecord,
  opts: KillOptions,
) {
  if (hasExited(record)) return;
  if (record.cancelling) {
    // Another caller is already escalating. Wait for it, but bounded
    // so an unkillable child doesn't wedge this caller's chain too.
    yield* exitedWithin(record, DEFAULT_GRACE_MS + UNKILLABLE_WAIT_MS);
    return;
  }
  record.cancelling = true;

  if (opts.reason) {
    Queue.offerUnsafe(record.output, {
      kind: "notice",
      data: `\r\n\x1b[2m[${opts.reason}]\x1b[0m\r\n`,
    });
  }

  yield* hostAttempt(() => signalTree(record.pid, "SIGTERM"));
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  if (yield* exitedWithin(record, graceMs)) return;

  yield* hostAttempt(() => signalTree(record.pid, "SIGKILL"));
  if (!(yield* exitedWithin(record, UNKILLABLE_WAIT_MS))) {
    // Give up rather than hanging the caller forever. The record stays
    // live on purpose: the process really is still running, so the busy
    // counts stay honest and a later delete attempt can retry.
    console.warn(
      `[scripts] "${record.scriptName}" (pid ${record.pid}) survived SIGKILL; giving up on this kill attempt`,
    );
  }
});

// On Effect's default runtime, not the app's: these Effects need no
// service, and the proofs run them with no runtime installed.
function runKill(record: RunRecord, opts: KillOptions): Promise<void> {
  return Effect.runPromise(killRecord(record, opts));
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
  // and deliberately adds no data dir pin: a script's whole process
  // tree inherits this, so naming a data dir here would follow the user's
  // command into anything it starts (see initDataDir). TERM and
  // COLORTERM advertise what xterm in the renderer renders. FORCE_COLOR
  // is for the tools a runner (turbo, concurrently, a `| tee`) drives
  // through pipes, which can't see the PTY and would go monochrome.
  // Pagers are off: stdout being a TTY would otherwise make git, gh and
  // friends wait in `less`, and a lifecycle script runs unattended.
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
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

  // The run's output stream. The queue exists, and the PTY's listeners
  // feed it, before this function returns, so no read can land ahead of
  // them; the pump below drains it on its own fiber.
  const output = makeScriptOutputQueue();

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
    cancelling: false,
    done: Deferred.makeUnsafe<void>(),
    output,
  };
  runningScripts.set(runId, record);
  persistSnapshot();

  const dataListener = pty.onData((data) => {
    Queue.offerUnsafe(output, { kind: "data", data });
  });

  // A read error on the PTY master is rethrown by node-pty unless
  // someone else listens for it, and an uncaught throw here takes the
  // whole main process down. This listener sits on the same socket as
  // node-pty's own, so it sees the EAGAIN/EIO noise that one filters
  // as part of a normal PTY lifecycle and must skip it too. node-pty
  // closes the PTY first, so the exit event follows a real error.
  const ptyEvents = pty as unknown as NodeJS.EventEmitter;
  const onError = (error: NodeJS.ErrnoException) => {
    const code = error.code ?? "";
    if (code.includes("EAGAIN") || code.includes("EIO")) return;
    Queue.offerUnsafe(output, { kind: "error", data: errorMessageOf(error) });
  };
  ptyEvents.on("error", onError);

  // node-pty reports exit only after the terminal stream has drained
  // (or a short grace period when a backgrounded grandchild still holds
  // the PTY open), so the run's last output never races the exit event
  // that makes the renderer unbind the runId. That grace is also the
  // only window in which a kill could target an already-reaped pid.
  // It is a couple hundred milliseconds, and the target would have to
  // be recycled as a group leader to be hit at all.
  const exitListener = pty.onExit(({ exitCode, signal }) => {
    // SIGTERM via our kill path commonly surfaces as exit 143 (128+15)
    // because the shell wrapping the user's command translated the
    // signal into an exit code. If we initiated the cancel, report
    // null code so the UI shows "stopped" not "failed". Read now, at
    // the exit, not when the event reaches the front of the stream.
    const wasSignal = signal !== undefined && signal !== 0;
    const code = record.cancelling || wasSignal ? null : exitCode;
    Queue.offerUnsafe(output, { kind: "exit", code });
    Queue.endUnsafe(output);
  });

  // Contained: the pump is the run's only way out to the renderer, and
  // a throw from a notify would end it with a defect nothing reports,
  // leaving the exit unsent and every kill waiting out its deadline.
  const notify = (payload: ScriptEvent) => {
    containedSync(`[scripts] "${record.scriptName}" event not delivered`, () =>
      args.notify(payload),
    );
  };
  const settle = (event: ScriptOutput) => {
    switch (event.kind) {
      case "data":
      case "notice":
        notify({ runId, kind: "data", data: event.data });
        return;
      case "error":
        notify({ runId, kind: "error", data: event.data });
        return;
      case "exit":
        notify({ runId, kind: "exit", code: event.code });
        Deferred.doneUnsafe(record.done, Effect.void);
        runningScripts.delete(runId);
        persistSnapshot();
        return;
    }
  };

  // The pump: the batched output stream, run on a fiber that owns the
  // scope the PTY listeners live in. It ends after the exit went out,
  // and its scope then drops the listeners.
  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            dataListener.dispose();
            exitListener.dispose();
            ptyEvents.off("error", onError);
          }),
        );
        yield* batchScriptOutput(output).pipe(
          Stream.runForEach((batch) =>
            Effect.sync(() => {
              if (batch.data !== "") {
                notify({ runId, kind: "data", data: batch.data });
              }
              if (batch.closedBy !== null) settle(batch.closedBy);
            }),
          ),
        );
      }),
    ),
  );

  return runId;
}

// Keystrokes from the console. A no-op when the run isn't one of ours
// (already exited, or a lifecycle script the CLI ran on the app's
// behalf, which streams output through the same events but has no PTY
// here).
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
  await runKill(record, { reason: "Cancelled by user" });
  return true;
}

async function killMatching(
  predicate: (record: RunRecord) => boolean,
  reason: string,
  opts: KillOptions = {},
): Promise<void> {
  const targets = Array.from(runningScripts.values()).filter(
    (r) => !hasExited(r) && predicate(r),
  );
  if (targets.length === 0) return;
  await Promise.all(targets.map((r) => runKill(r, { reason, ...opts })));
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
    if (hasExited(record)) continue;
    signalTreeBestEffort(record.pid, signal);
  }
}
