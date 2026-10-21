// The runs: per-project scripts under a PTY (./ScriptRuns.ts, each in a
// scope of its own), whose output streams to the window that started
// them and any that attached, and which take keystrokes and window
// sizes back; and the lifecycle scripts the engine runs on the app's
// behalf, booked here so the console can show and stop them. Each PTY
// run leads its own session, so a stop takes the whole tree of
// children the user's command spawned.
import { randomUUID } from "node:crypto";
import { errorWordsOf } from "@host/lib/errorWords";
import {
  type RunningScript,
  runScriptName,
  type ScriptEvent,
  scriptErrorLine,
  type ScriptRunSlot,
} from "@shigomori/contracts/schemas";
import { scriptEnvOf, UNATTENDED_ENV } from "@shigomori/contracts/scriptEnv";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { Marks } from "./marks";
import { OrphanSweep } from "./OrphanSweep";
import { signalPidTree } from "./process";
import { ScriptChanges } from "./ScriptChanges";
import {
  type PtyHandle,
  ScriptRuns,
  type Stopping,
  UNKILLABLE_WAIT_MS,
} from "./ScriptRuns";
import {
  type NotifyScriptEvent,
  type RunArgs,
  type RunningScriptWorktree,
  ScriptRefusedError,
} from "./documents";

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

// What the kill chain (killRecord) needs of a run. The app's own PTY
// runs and the engine's lifecycle runs both keep one. They differ in
// how a signal reaches the tree.
interface Killable {
  runId: string;
  scriptName: string;
  exited: boolean;
  cancelling: boolean;
  done: Promise<void>;
  stream: RunStream;
  // SIGTERM, then SIGKILL past the grace, then a bounded wait for the
  // tree to go.
  stop: (graceMs: number) => Effect.Effect<void>;
  // Sends whatever output is pooled for the next frame (see
  // OUTPUT_FLUSH_MS). Anything else that emits into the run's stream
  // must call it first so it lands after the output that preceded it.
  flushOutput: () => void;
}

interface RunRecord extends Killable {
  pty: PtyHandle;
  // Closes the run's scope (./ScriptRuns.ts): the kill chain, a hurried quit's
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
  startedAt: number;
}

// A lifecycle script an engine run started (a create's setup, an rm's
// teardown), which streams through the same events but has no PTY here.
// Booked from its "started" document and dropped on its "exit". Not
// persisted: each ends with the engine run that started it, a quit's
// included.
interface LifecycleRun extends Killable {
  settle: () => void;
  projectId: string;
  worktreeId: string;
  slot: ScriptRunSlot;
  startedAt: number;
}

// One engine run's script events, on their way to the renderer.
export interface LifecycleRuns {
  readonly forward: (event: ScriptEvent) => void;
  // The engine run went away without an exit for a script it started
  // (killed, crashed).
  readonly end: () => void;
}

const settledWithin = (done: Promise<void>, ms: number) =>
  Effect.promise(() => done).pipe(
    Effect.timeoutOption(Duration.millis(ms)),
    Effect.map(Option.isSome),
  );

export const makeRuns = ({
  marks,
  env: baseEnv,
}: {
  readonly marks: Marks;
  readonly env: () => NodeJS.ProcessEnv;
}) =>
  Effect.gen(function* () {
    const scriptRuns = yield* ScriptRuns;
    const sweep = yield* OrphanSweep;
    const { announce } = yield* ScriptChanges;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ptyRuns = new Map<string, RunRecord>();
    const lifecycle = new Map<string, LifecycleRun>();

    const killRecord = Effect.fnUntraced(function* (
      record: Killable,
      opts: { readonly graceMs?: number; readonly reason: string },
    ) {
      if (record.exited) return;
      if (record.cancelling) {
        // Another caller is already escalating. Wait for it, but bounded
        // so an unkillable child doesn't wedge this caller's chain too.
        yield* settledWithin(
          record.done,
          DEFAULT_GRACE_MS + UNKILLABLE_WAIT_MS,
        );
        return;
      }
      record.cancelling = true;
      record.flushOutput();
      record.stream.emit({
        runId: record.runId,
        kind: "data",
        data: `\r\n\x1b[2m[${opts.reason}]\x1b[0m\r\n`,
      });
      yield* record.stop(opts.graceMs ?? DEFAULT_GRACE_MS);
    });

    // The kill chain for a lifecycle script, which leads no group of its
    // own: its pid and descendants, never its group.
    const stopPidTree = Effect.fnUntraced(
      function* (pid: number, done: Promise<void>, graceMs: number) {
        yield* signalPidTree(pid, "SIGTERM");
        if (yield* settledWithin(done, graceMs)) return;
        yield* signalPidTree(pid, "SIGKILL");
        if (!(yield* settledWithin(done, UNKILLABLE_WAIT_MS))) {
          yield* Effect.logWarning(
            `[scripts] lifecycle script (pid ${pid}) survived SIGKILL; giving up on this kill attempt`,
          );
        }
      },
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    // An exit the app cancelled reports null the way a cancelled PTY run
    // does, so the UI says stopped, not failed (the shell turns SIGTERM
    // into exit 143). `end` drops the bookings so a pending kill chain
    // returns and nothing can be signalled at a stale pid.
    const lifecycleRuns = Effect.fn("Scripts.lifecycleRuns")(function* (
      notify: NotifyScriptEvent,
    ) {
      const clock = yield* Clock.Clock;
      const own = new Set<string>();
      const drop = (runId: string): LifecycleRun | undefined => {
        const run = lifecycle.get(runId);
        if (!run) return undefined;
        run.exited = true;
        run.settle();
        lifecycle.delete(runId);
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
            lifecycle.set(event.runId, {
              runId: event.runId,
              scriptName: runScriptName(event.slot),
              exited: false,
              cancelling: false,
              done,
              stream: createRunStream(notify),
              stop: (graceMs) => stopPidTree(pid, done, graceMs),
              flushOutput: () => {},
              settle,
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              slot: event.slot,
              startedAt: clock.currentTimeMillisUnsafe(),
            });
            own.add(event.runId);
            announce();
            notify(event);
            return;
          }
          // A booked run's events go through its stream, so a window that
          // attached to it hears them too.
          const run = lifecycle.get(event.runId);
          if (event.kind === "exit" && run) {
            drop(event.runId);
            if (run.cancelling) event = { ...event, code: null };
            announce();
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
          announce();
        },
      } satisfies LifecycleRuns;
    });

    const start = Effect.fn("Scripts.start")(function* (args: RunArgs) {
      const refused = marks.refusal(args.worktree.id, args.project.id);
      if (refused !== null) {
        return yield* new ScriptRefusedError({ reason: refused });
      }
      const runId = randomUUID();

      // Inherits the app's environment plus the SHIGOMORI_* contract vars,
      // and deliberately adds no data dir pin: a script's whole process
      // tree inherits this, so naming a data dir here would follow the user's
      // command into anything it starts (see initDataDir). COLORTERM
      // advertises what xterm in the renderer renders.
      const env = {
        ...baseEnv(),
        ...UNATTENDED_ENV,
        COLORTERM: "truecolor",
        ...scriptEnvOf(
          {
            worktree: args.worktree,
            project: args.project,
            ...args.scriptEnv,
          },
          runScriptName(args.slot),
        ),
      };

      const { pty, close } = yield* scriptRuns
        .open({
          command: args.command,
          cwd: args.worktree.path,
          place: "worktree",
          env,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        })
        .pipe(
          Effect.tapError((error) =>
            error.reason === "failed"
              ? Effect.logWarning(
                  `[scripts] the PTY did not start: ${errorWordsOf(error.cause)}`,
                )
              : Effect.void,
          ),
        );
      const startedAt = yield* Clock.currentTimeMillis;
      // A delete that marked the worktree while the PTY started has
      // already stopped the scripts it found there.
      const refusedNow = marks.refusal(args.worktree.id, args.project.id);
      if (refusedNow !== null) {
        yield* close({ graceMs: DEFAULT_GRACE_MS, wait: true });
        return yield* new ScriptRefusedError({ reason: refusedNow });
      }

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
        pty,
        projectId: args.project.id,
        worktreeId: args.worktree.id,
        slot: args.slot,
        worktreeName: args.worktree.name,
        worktreePath: args.worktree.path,
        scriptName: runScriptName(args.slot),
        startedAt,
        exited: false,
        cancelling: false,
        done,
        stream,
        close,
        stop: (graceMs) => close({ graceMs, wait: true }),
        flushOutput,
      };
      ptyRuns.set(runId, record);
      announce();

      pty.onData((data) => {
        pendingOutput += data;
        if (pendingOutput.length >= OUTPUT_FLUSH_BYTES) flushOutput();
        else if (!flushTimer) {
          flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
        }
      });

      pty.onError((error) => {
        flushOutput();
        stream.emit({ runId, kind: "error", data: errorWordsOf(error) });
      });

      // The exit comes after the run's last output (./ScriptRuns.ts), so the
      // renderer never unbinds the runId ahead of it.
      pty.onExit(({ exitCode, signal }) => {
        // The shell wrapping the user's command turns our SIGTERM into
        // exit 143, so a cancel reports null: the UI shows "stopped",
        // not "failed".
        const wasSignal = signal !== undefined && signal !== 0;
        const reported = record.cancelling || wasSignal ? null : exitCode;
        flushOutput();
        stream.emit({ runId, kind: "exit", code: reported });
        record.exited = true;
        resolveDone();
        ptyRuns.delete(runId);
        announce();
      });

      // Recorded until its exit, so a crash that skips the kill chains
      // leaves the next boot something to sweep (./OrphanSweep.ts). After
      // the listeners, since a quick command may finish while the store
      // writes, and the PTY replays nothing.
      yield* sweep.record(
        {
          runId,
          pid: pty.pid,
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          startedAt: record.startedAt,
          command: args.command,
        },
        pty.exit,
      );

      return runId;
    });

    // Both can fail on a PTY being torn down (its exit is already on its
    // way), which is not worth reporting.
    const write = (runId: string, data: string): void => {
      try {
        ptyRuns.get(runId)?.pty.write(data);
      } catch {}
    };
    const resize = (runId: string, cols: number, rows: number): void => {
      try {
        ptyRuns.get(runId)?.pty.resize(cols, rows);
      } catch {}
    };

    const cancel = Effect.fn("Scripts.cancel")(function* (runId: string) {
      const record = ptyRuns.get(runId) ?? lifecycle.get(runId);
      if (!record) return false;
      yield* killRecord(record, { reason: "Cancelled by user" });
      return true;
    });

    const live = () => [...ptyRuns.values()].filter((r) => !r.exited);

    const stopMatching = (
      predicate: (record: RunRecord) => boolean,
      reason: string,
      graceMs?: number,
    ) =>
      Effect.forEach(
        live().filter(predicate),
        (record) => killRecord(record, { reason, graceMs }),
        { concurrency: "unbounded", discard: true },
      );

    const worktrees = (): ReadonlyArray<RunningScriptWorktree> => {
      const byWorktree = new Map<string, RunningScriptWorktree>();
      for (const record of live()) {
        const existing = byWorktree.get(record.worktreeId);
        byWorktree.set(record.worktreeId, {
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          worktreeName: record.worktreeName,
          worktreePath: record.worktreePath,
          scriptCount: (existing?.scriptCount ?? 0) + 1,
        });
      }
      return [...byWorktree.values()];
    };

    const list = (): ReadonlyArray<RunningScript> =>
      [
        ...live().map((record) => ({
          runId: record.runId,
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          slot: record.slot,
          startedAt: record.startedAt,
          interactive: true,
        })),
        ...[...lifecycle.values()]
          .filter((run) => !run.exited)
          .map((run) => ({
            runId: run.runId,
            projectId: run.projectId,
            worktreeId: run.worktreeId,
            slot: run.slot,
            startedAt: run.startedAt,
            interactive: false,
          })),
      ].toSorted((a, b) => a.startedAt - b.startedAt);

    const attach = (runId: string, notify: NotifyScriptEvent) => {
      const run = ptyRuns.get(runId) ?? lifecycle.get(runId);
      if (!run || run.exited) return null;
      return run.stream.attach(notify);
    };

    return {
      start,
      write,
      resize,
      cancel,
      attach,
      list,
      worktrees,
      runningIn: (worktreeId: string) =>
        live().filter((record) => record.worktreeId === worktreeId).length,
      lifecycleRuns,
      stopWorktree: Effect.fn("Scripts.stopWorktree")((worktreeId: string) =>
        stopMatching((r) => r.worktreeId === worktreeId, "Worktree removed"),
      ),
      stopProject: Effect.fn("Scripts.stopProject")((projectId: string) =>
        stopMatching((r) => r.projectId === projectId, "Project removed"),
      ),
      // The PTY runs `runIds` names, their project gone.
      stopRuns: Effect.fn("Scripts.stopRuns")((runIds: ReadonlySet<string>) =>
        stopMatching((r) => runIds.has(r.runId), "Project removed"),
      ),
      stopAll: Effect.fn("Scripts.stopAll")(
        (options: { readonly graceMs?: number } = {}) =>
          stopMatching(() => true, "App quit", options.graceMs),
      ),
      // One SIGTERM to every run's tree and no waiting, for the
      // update-install quit: the kill chain would hold up the installer
      // waiting on this process to exit.
      signalAll: Effect.suspend(() =>
        Effect.forEach(
          live(),
          (record) => record.close({ graceMs: 0, wait: false }),
          { discard: true },
        ),
      ),
      count: () => ptyRuns.size + lifecycle.size,
    };
  });

export type Runs = Effect.Success<ReturnType<typeof makeRuns>>;
