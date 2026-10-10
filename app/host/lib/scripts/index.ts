// Spawn per-project scripts under a PTY and stream their terminal
// output to the renderer, which feeds keystrokes and window-size changes
// back through writeToScript / resizeScript. Each script runs in its
// own session so we can kill the entire tree of children (dev servers,
// watchers, compilers the user's command spawns), not just the wrapping
// shell.
//
// The PTY and its kill chain live in ./pty.ts, each run in a scope of
// its own: stopping a run is closing that scope.
//
// On app quit (host/process/layer.ts) we kill every running script the same way
// before letting the host exit, so a Cmd-Q never orphans `npm run dev`.
import type { BusyOperations } from "@shared/busy";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  errorMessageOf,
  WorktreeSettingUpError,
} from "@shigomori/contracts/errors";
import { holdRootChecks } from "@host/mirror/registry";
import {
  type Project,
  type RunningScript,
  runScriptName,
  type ScriptEvent,
  scriptErrorLine,
  type ScriptRunSlot,
} from "@shigomori/contracts/schemas";
import { SCRIPT_ENV_KEYS } from "@shigomori/contracts/scriptEnv";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type PersistedScript, persistRunningScripts } from "./persistence";
import { signalPidTree } from "./process";
import {
  type PtyHandle,
  ScriptRuns,
  type Stopping,
  UNKILLABLE_WAIT_MS,
} from "./pty";
import { Terminals } from "../terminals/Terminals";

// A script that can't start here now, in words for the console.
class ScriptRefusedError extends Schema.TaggedError<ScriptRefusedError>()(
  "ScriptRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// A delete or move of a worktree something else is already removing or
// moving, in the caller's words.
class WorktreeBusyError extends Schema.TaggedError<WorktreeBusyError>()(
  "WorktreeBusyError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// Renderer-facing emit callback supplied by the IPC handler. Lets the
// scripts layer stay Electron-free while still streaming events to the
// caller's window.
export type NotifyScriptEvent = ((payload: ScriptEvent) => void) & {
  // The connection it delivers to (its handler's signal, one per
  // window generation or peer socket), so a run's stream can tell a
  // connection that already hears it from a new one.
  connection?: AbortSignal;
};

const DEFAULT_GRACE_MS = 3_000;
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
const OUTPUT_FLUSH_MS = 16;
const OUTPUT_FLUSH_BYTES = 64 * 1024;
// Output kept per run for a window that attaches after it started (the
// console opened from another window or device, or after a reload), so
// it opens on the run's recent output rather than a blank terminal.
// The renderer keeps up to a megabyte of what it has seen. This only
// has to set the scene.
const BACKLOG_BYTES = 256 * 1024;

// One run's event stream: the window that started it, and any that
// attached since (scripts:attach), each fed every event from then on.
// Output is kept as a backlog for the next to attach.
interface RunStream {
  emit: (event: ScriptEvent) => void;
  // The output so far, and whether the connection already heard the
  // run before this attach (it started it, or attached before): its
  // events are then not sent a second time, and the caller drops what
  // it buffered of them, which the backlog repeats.
  attach: (watcher: NotifyScriptEvent) => {
    output: string;
    streaming: boolean;
  };
}

function createRunStream(starter: NotifyScriptEvent): RunStream {
  const chunks: string[] = [];
  let bytes = 0;
  // Each attached connection's notifier, and how to stop listening for
  // the connection going, so a run that ends lets go of both (and with
  // them this backlog), whatever the connections outlive it by.
  const watchers = new Map<
    AbortSignal,
    { notify: NotifyScriptEvent; unlisten: () => void }
  >();
  const keep = (data: string) => {
    chunks.push(data);
    bytes += data.length;
    let drop = 0;
    while (bytes > BACKLOG_BYTES && drop < chunks.length - 1) {
      bytes -= chunks[drop]?.length ?? 0;
      drop++;
    }
    if (drop > 0) chunks.splice(0, drop);
  };
  return {
    emit: (event) => {
      if (event.kind === "data") keep(event.data);
      if (event.kind === "error") keep(scriptErrorLine(event.data));
      starter(event);
      for (const { notify } of watchers.values()) {
        try {
          notify(event);
        } catch {}
      }
      if (event.kind === "exit") {
        for (const { unlisten } of watchers.values()) unlisten();
        watchers.clear();
        chunks.length = 0;
      }
    },
    attach: (watcher) => {
      const output = chunks.join("");
      const signal = watcher.connection;
      if (
        signal === undefined ||
        signal === starter.connection ||
        watchers.has(signal)
      ) {
        return { output, streaming: signal !== undefined };
      }
      if (!signal.aborted) {
        const drop = () => watchers.delete(signal);
        signal.addEventListener("abort", drop, { once: true });
        watchers.set(signal, {
          notify: watcher,
          unlisten: () => signal.removeEventListener("abort", drop),
        });
      }
      return { output, streaming: false };
    },
  };
}

interface ScriptWorktree {
  id: string;
  name: string;
  branch: string;
  path: string;
}

// The SHIGOMORI_* values startScript can't derive from the worktree
// and project it is given (the engine's ScriptContext).
export interface ScriptEnvValues {
  // Branch checked out in the primary worktree; "" when there is none.
  projectBranch: string;
  // "" when the default branch can't be resolved (no remote, empty repo).
  defaultBranch: string;
  // What `sm describe` set, "" when unset.
  title: string;
  description: string;
}

// The SHIGOMORI_* values that say which worktree a process runs in,
// for a script and a worktree's terminal alike.
export function worktreeEnv(
  worktree: ScriptWorktree,
  project: Pick<Project, "path" | "name">,
  values: ScriptEnvValues,
): Record<string, string> {
  return {
    [SCRIPT_ENV_KEYS.WORKTREE_PATH]: worktree.path,
    [SCRIPT_ENV_KEYS.WORKTREE_NAME]: worktree.name,
    [SCRIPT_ENV_KEYS.WORKTREE_BRANCH]: worktree.branch,
    [SCRIPT_ENV_KEYS.WORKTREE_ID]: worktree.id,
    [SCRIPT_ENV_KEYS.WORKTREE_TITLE]: values.title,
    [SCRIPT_ENV_KEYS.WORKTREE_DESCRIPTION]: values.description,
    [SCRIPT_ENV_KEYS.PROJECT_PATH]: project.path,
    [SCRIPT_ENV_KEYS.PROJECT_NAME]: project.name,
    [SCRIPT_ENV_KEYS.PROJECT_BRANCH]: values.projectBranch,
    [SCRIPT_ENV_KEYS.DEFAULT_BRANCH]: values.defaultBranch,
  };
}

interface RunArgs {
  command: string;
  // The run's name (SHIGOMORI_SCRIPT_NAME, the logs) is the slot's.
  slot: ScriptRunSlot;
  worktree: ScriptWorktree;
  project: Pick<Project, "id" | "path" | "name">;
  // The branch values of the SHIGOMORI_* env contract, for a command
  // that doesn't set that env itself. Absent for `sm run`, which does.
  scriptEnv?: ScriptEnvValues;
  notify: NotifyScriptEvent;
}

// What the kill chain (killRecord) needs of a run. The app's own PTY
// runs and the engine-run lifecycle scripts (cliScriptStream) both keep
// one. They differ in how a signal reaches the tree.
interface Killable {
  runId: string;
  pid: number;
  scriptName: string;
  exited: boolean;
  cancelling: boolean;
  done: Promise<void>;
  stream: RunStream;
  // SIGTERM, then SIGKILL past the grace, then a bounded wait for the
  // tree to go.
  stop: (graceMs: number) => Effect.Effect<void, never, KillServices>;
  // Sends whatever output is pooled for the next frame (see
  // OUTPUT_FLUSH_MS). Anything else that emits into the run's stream
  // must call it first so it lands after the output that preceded it.
  flushOutput: () => void;
}

interface RunRecord extends Killable {
  pty: PtyHandle;
  // Closes the run's scope (./pty.ts): the kill chain, a hurried quit's
  // SIGTERM and no wait, or nothing for a run already over.
  close: (stopping: Stopping) => Effect.Effect<void>;
  projectId: string;
  worktreeId: string;
  slot: ScriptRunSlot;
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
}

// What stopping a run reaches: the signals an engine-run script's tree is
// sent through.
type KillServices = Effect.Services<ReturnType<typeof signalPidTree>>;

const runningScripts = new Map<string, RunRecord>();

// Lifecycle scripts the engine runs on the app's behalf (a create's
// setup, an rm's teardown), which stream through the same events but
// have no PTY here. Booked from their "started" document so the
// console's Stop reaches them (cancelScript), and dropped on their
// "exit". Not persisted: each ends with the engine run that started
// it, a quit's included.
interface CliScriptRun extends Killable {
  settle: () => void;
  projectId: string;
  worktreeId: string;
  slot: ScriptRunSlot;
  startedAt: number;
}

const cliScripts = new Map<string, CliScriptRun>();

// One engine run's script events, on their way to the renderer. An exit
// the app cancelled reports null the way a cancelled PTY run does, so
// the UI says stopped, not failed (the shell turns SIGTERM into exit
// 143). `end` is for the engine run going away without an exit for a script
// it started (killed, crashed): the booking is dropped so a pending
// kill chain returns and nothing can be signalled at a stale pid.
export function cliScriptStream(notify: NotifyScriptEvent): {
  forward: (event: ScriptEvent) => void;
  end: () => void;
} {
  const own = new Set<string>();
  const drop = (runId: string): CliScriptRun | undefined => {
    const run = cliScripts.get(runId);
    if (!run) return undefined;
    run.exited = true;
    run.settle();
    cliScripts.delete(runId);
    own.delete(runId);
    return run;
  };
  return {
    forward: (event) => {
      if (event.kind === "started" && event.pid !== undefined) {
        const pid = event.pid;
        let settle!: () => void;
        const done = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const stream = createRunStream(notify);
        cliScripts.set(event.runId, {
          runId: event.runId,
          pid,
          scriptName: runScriptName(event.slot),
          exited: false,
          cancelling: false,
          done,
          stream,
          stop: (graceMs) => stopPidTree(pid, done, graceMs),
          flushOutput: () => {},
          settle,
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          slot: event.slot,
          startedAt: Date.now(),
        });
        own.add(event.runId);
        runningScriptsChanged();
        notify(event);
        return;
      }
      // A booked run's events go through its stream, so a window that
      // attached to it hears them too.
      const run = cliScripts.get(event.runId);
      if (event.kind === "exit" && run) {
        drop(event.runId);
        if (run.cancelling) event = { ...event, code: null };
        runningScriptsChanged();
      }
      (run?.stream.emit ?? notify)(event);
    },
    end: () => {
      if (own.size === 0) return;
      for (const runId of own) {
        const run = drop(runId);
        // Its exit never came, so it is said here: the window that
        // started it and any that attached would otherwise wait on it.
        run?.stream.emit({ runId, kind: "exit", code: null });
      }
      runningScriptsChanged();
    },
  };
}

// Told whenever a script starts or ends, whoever ran it, so the
// binding can tell every window and peer (scripts:changed). One
// listener: the binding is the only one that asks.
let runningScriptsChanged: () => void = () => {};

export function onRunningScriptsChanged(listener: () => void): void {
  runningScriptsChanged = listener;
}

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

// Worktrees whose create run (carry-over, the setup script, port
// provision) is still working in the checkout: past the engine's
// "created" document, not yet exited.
const inflightCreateIds = new Set<string>();

export function markCreateInflight(worktreeId: string): void {
  inflightCreateIds.add(worktreeId);
}

export function clearCreateInflight(worktreeId: string): void {
  inflightCreateIds.delete(worktreeId);
}

// Refuse a delete or move of a worktree something is already working
// in: another delete or move (with the caller's busy message), or its
// create run, which removing or moving the folder would pull the
// checkout out from under.
export const assertWorktreeMutable = (
  worktreeId: string,
  busyMessage: string,
): Effect.Effect<void, WorktreeBusyError | WorktreeSettingUpError> =>
  inflightDeleteCounts.has(worktreeId)
    ? Effect.fail(new WorktreeBusyError({ reason: busyMessage }))
    : inflightCreateIds.has(worktreeId)
      ? Effect.fail(new WorktreeSettingUpError())
      : Effect.void;

// The one place the tombstone protocol is spelled out: refuse a
// concurrent mutation of the same worktree or one still being created
// (assertWorktreeMutable), mark the id, reap app-spawned scripts before the mutation
// (a dev server would otherwise outlive its worktree or keep running
// in the old path), stop the mirrors rooted in it after the mutation
// (a session would otherwise sit halted on a root that is gone or
// moved, with the peer still calling its worktree mirrored), and
// always clear the mark. The mirrors go AFTER, not before: the engine may
// refuse the mutation (a dirty tree without --force), and a mirror
// stopped ahead of a refusal cannot be started again while the branch
// is still checked out here. The engine is two-way safe, so the gap
// between the root vanishing and the stop propagates nothing. Callers
// supply the busy message because the operations differ (removed vs
// moved). `mirrorsAfter` is what becomes of the mirrors once the
// mutation answered: a delete stops them only when the worktree
// actually went (a failed cleanup keeps it, and its mirror with it),
// and a move carries them to the new path.
export const withDeleteInflight = <A, E, R, E2, R2>(
  worktreeId: string,
  busyMessage: string,
  run: Effect.Effect<A, E, R>,
  mirrorsAfter: (result: A) => Effect.Effect<unknown, E2, R2>,
) => withDeletesInflight([worktreeId], busyMessage, run, mirrorsAfter);

// The protocol over several worktrees removed by one mutation (a stack
// cleanup): every id is refused-if-busy and marked up front, the
// scripts of all of them are reaped before, and `mirrorsAfter` deals
// with the mirrors of the ones the mutation took. A mutation that
// removes only some of them (a cleanup script failed partway) stops
// only those mirrors.
export const withDeletesInflight = <A, E, R, E2, R2>(
  worktreeIds: readonly string[],
  busyMessage: string,
  run: Effect.Effect<A, E, R>,
  mirrorsAfter: (result: A) => Effect.Effect<unknown, E2, R2>,
) =>
  Effect.gen(function* () {
    for (const id of worktreeIds) {
      yield* assertWorktreeMutable(id, busyMessage);
    }
    // The roots vanish under the mutation: the mirror bookkeeping leaves
    // them to `mirrorsAfter` rather than read a move as a removal.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        worktreeIds.forEach(markDeleteInflight);
        return holdRootChecks(worktreeIds);
      }),
      () =>
        Effect.gen(function* () {
          yield* Effect.forEach(worktreeIds, killScriptsForWorktree, {
            concurrency: "unbounded",
            discard: true,
          });
          const result = yield* run;
          yield* Effect.flatMap(Terminals, (it) => it.closeMissing);
          yield* mirrorsAfter(result);
          return result;
        }),
      (releaseRoots) =>
        Effect.sync(() => {
          releaseRoots();
          worktreeIds.forEach(clearDeleteInflight);
        }),
    );
  });

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

export type { BusyOperations } from "@shared/busy";

// Extra sources of in-flight lifecycle work that live outside this
// module (lib/engine.ts registers the engine's changing calls).
// Aggregating here means every getBusyOperations caller sees the full
// picture instead of each consumer patching the count locally.
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

// Every script running here now, the app's own and the engine's
// lifecycle runs alike, oldest first (scripts:list).
export function listRunningScripts(): RunningScript[] {
  const runs: RunningScript[] = [];
  for (const record of runningScripts.values()) {
    if (record.exited) continue;
    runs.push({
      runId: record.runId,
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      slot: record.slot,
      startedAt: record.startedAt,
      interactive: true,
    });
  }
  for (const run of cliScripts.values()) {
    if (run.exited) continue;
    runs.push({
      runId: run.runId,
      projectId: run.projectId,
      worktreeId: run.worktreeId,
      slot: run.slot,
      startedAt: run.startedAt,
      interactive: false,
    });
  }
  return runs.toSorted((a, b) => a.startedAt - b.startedAt);
}

// Joins a running script's stream from a window that did not start it:
// every event from now on goes to `notify` too, until the run ends or
// the caller's connection goes (`signal`). Answers the output so far,
// or null for a run that is not running here.
export function attachScript(
  runId: string,
  notify: NotifyScriptEvent,
): { output: string; streaming: boolean } | null {
  const run = runningScripts.get(runId) ?? cliScripts.get(runId);
  if (!run || run.exited) return null;
  return run.stream.attach(notify);
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

// Whether `done` settled within `ms`.
const settledWithin = (done: Promise<void>, ms: number) =>
  Effect.promise(() => done).pipe(
    Effect.timeoutOption(Duration.millis(ms)),
    Effect.map(Option.isSome),
  );

interface KillOptions {
  graceMs?: number;
  reason?: string;
}

const killRecord = Effect.fnUntraced(function* (
  record: Killable,
  opts: KillOptions,
) {
  if (record.exited) return;
  if (record.cancelling) {
    // Another caller is already escalating. Wait for it, but bounded
    // so an unkillable child doesn't wedge this caller's chain too.
    yield* settledWithin(record.done, DEFAULT_GRACE_MS + UNKILLABLE_WAIT_MS);
    return;
  }
  record.cancelling = true;

  if (opts.reason) {
    record.flushOutput();
    record.stream.emit({
      runId: record.runId,
      kind: "data",
      data: `\r\n\x1b[2m[${opts.reason}]\x1b[0m\r\n`,
    });
  }

  yield* record.stop(opts.graceMs ?? DEFAULT_GRACE_MS);
});

// The kill chain for a lifecycle script the engine runs, which leads no
// group of its own: its pid and descendants, never its group
// (cliScriptStream).
const stopPidTree = Effect.fnUntraced(function* (
  pid: number,
  done: Promise<void>,
  graceMs: number,
) {
  yield* signalPidTree(pid, "SIGTERM");
  if (yield* settledWithin(done, graceMs)) return;
  yield* signalPidTree(pid, "SIGKILL");
  if (!(yield* settledWithin(done, UNKILLABLE_WAIT_MS))) {
    yield* Effect.logWarning(
      `[scripts] lifecycle script (pid ${pid}) survived SIGKILL; giving up on this kill attempt`,
    );
  }
});

export const startScript = Effect.fn("Scripts.start")(function* (
  args: RunArgs,
) {
  const refuse = (reason: string) => new ScriptRefusedError({ reason });
  if (shuttingDown) {
    return yield* refuse(
      "App is shutting down; refusing to start a new script.",
    );
  }
  // Runs must not land in a worktree that's mid-delete: the delete flow
  // snapshots running scripts once (killScriptsForWorktree), so a spawn
  // slipping in after that leaves a live dev server whose cwd is being
  // rm'd.
  if (inflightDeleteCounts.has(args.worktree.id)) {
    return yield* refuse("This worktree is being deleted.");
  }
  if (inflightProjectDeleteIds.has(args.project.id)) {
    return yield* refuse("This project is being removed.");
  }

  // node-pty's helper does the chdir itself and exits 1 without a word
  // when it fails, which the console would show as a bare "exit 1".
  // Name the cause here instead.
  if (!existsSync(args.worktree.path)) {
    return yield* refuse(
      `Worktree directory is missing: ${args.worktree.path}`,
    );
  }

  const runId = randomUUID();

  // Inherits the app's environment plus the SHIGOMORI_* contract vars
  // (unless the command is `sm run`, which sets them itself),
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
    ...(args.scriptEnv && {
      [SCRIPT_ENV_KEYS.SCRIPT_NAME]: runScriptName(args.slot),
      ...worktreeEnv(args.worktree, args.project, args.scriptEnv),
    }),
  };

  // Fails when no process could be started. The caller's IPC rejection
  // carries the message into the console.
  const { pty, close } = yield* (yield* ScriptRuns)
    .open({
      command: args.command,
      cwd: args.worktree.path,
      env,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    })
    .pipe(
      Effect.tapError((error) =>
        error.reason === "failed"
          ? Effect.logWarning(
              `[scripts] the PTY did not start: ${errorMessageOf(error.cause)}`,
            )
          : Effect.void,
      ),
    );

  // The PTY is one ordered byte stream (stdout and stderr share the
  // terminal), so the renderer's xterm sees exactly what a real
  // terminal would, and concatenating reads before sending changes
  // nothing it renders.
  const stream = createRunStream(args.notify);
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
    stream.emit({ runId, kind: "data", data });
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
    slot: args.slot,
    worktreeName: args.worktree.name,
    worktreePath: args.worktree.path,
    scriptName: runScriptName(args.slot),
    command: args.command,
    startedAt: Date.now(),
    exited: false,
    cancelling: false,
    done,
    stream,
    close,
    stop: (graceMs) => close({ graceMs, wait: true }),
    flushOutput,
  };
  runningScripts.set(runId, record);
  persistSnapshot();
  runningScriptsChanged();

  pty.onData((data) => {
    pendingOutput += data;
    if (pendingOutput.length >= OUTPUT_FLUSH_BYTES) flushOutput();
    else if (!flushTimer) flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
  });

  pty.onError((error) => {
    flushOutput();
    stream.emit({ runId, kind: "error", data: errorMessageOf(error) });
  });

  // The exit comes after the run's last output (./pty.ts), so the
  // renderer never unbinds the runId ahead of it.
  pty.onExit(({ exitCode, signal }) => {
    // SIGTERM via our kill path commonly surfaces as exit 143 (128+15)
    // because the shell wrapping the user's command translated the
    // signal into an exit code. If we initiated the cancel, report
    // null code so the UI shows "stopped" not "failed".
    const wasSignal = signal !== undefined && signal !== 0;
    const reported = record.cancelling || wasSignal ? null : exitCode;
    flushOutput();
    stream.emit({ runId, kind: "exit", code: reported });
    record.exited = true;
    resolveDone();
    runningScripts.delete(runId);
    persistSnapshot();
    runningScriptsChanged();
  });

  return runId;
});

// Keystrokes from the console. A no-op when the run isn't one of ours
// (already exited, or a lifecycle script the engine ran on the app's
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

// The console's Stop: a run the app spawned, or a lifecycle script the
// engine is running on its behalf.
export const cancelScript = Effect.fn("Scripts.cancel")(function* (
  runId: string,
) {
  const record = runningScripts.get(runId) ?? cliScripts.get(runId);
  if (!record) return false;
  yield* killRecord(record, { reason: "Cancelled by user" });
  return true;
});

const killMatching = (
  predicate: (record: RunRecord) => boolean,
  reason: string,
  opts: KillOptions = {},
) =>
  Effect.forEach(
    Array.from(runningScripts.values()).filter(
      (r) => !r.exited && predicate(r),
    ),
    (r) => killRecord(r, { reason, ...opts }),
    { concurrency: "unbounded", discard: true },
  );

export const killScriptsForWorktree = (worktreeId: string) =>
  killMatching((r) => r.worktreeId === worktreeId, "Worktree removed");

export const killScriptsForProject = (projectId: string) =>
  killMatching((r) => r.projectId === projectId, "Project removed");

// The one caller that tunes the grace period is the quit path, which
// can't wait out the default before the shell tears the host down.
export const killAllScripts = (opts: KillOptions = {}) =>
  killMatching(() => true, "App quit", opts);

// One SIGTERM to every running script's tree and no waiting, for the
// update-install quit path: the full kill chain would block the handoff
// to the detached installer waiting on our exit, but well-behaved
// scripts still get to clean up.
export const signalAllScriptsBestEffort = Effect.suspend(() =>
  Effect.forEach(
    Array.from(runningScripts.values()).filter((record) => !record.exited),
    (record) => record.close({ graceMs: 0, wait: false }),
    { discard: true },
  ),
);
