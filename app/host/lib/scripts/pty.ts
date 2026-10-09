// Script runs under a pseudo-terminal (node-pty), each a resource in a
// scope of its own under the ScriptRuns layer's.
//
// Scripts run in a PTY rather than on pipes, so the console behaves
// like a terminal: programs see a TTY, get a real window size, emit
// color without coaxing, and can read keystrokes the renderer forwards
// (interactive prompts, vite's "r"/"q" shortcuts, TUIs). node-pty is not
// a child_process, so this is the wrapper that gives a PTY child the
// shape of an effect/process one: acquired in a scope, its release the
// kill chain (./process.ts), its exit an effect to wait on.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { type IPty, spawn as spawnPty } from "node-pty";
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as PromiseAdapter from "../util/promiseAdapter";
import { envSetting } from "../../../shared/config.ts";
import { log } from "@shared/log";
import { signalTree, signalTreeBestEffort } from "./process";

// No process could be started: a missing login shell, or a PTY that
// could not be allocated. The console shows the message.
export class PtySpawnError extends Schema.TaggedError<PtySpawnError>()(
  "PtySpawnError",
  {
    shell: Schema.String,
    reason: Schema.Literals(["shell-missing", "failed"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.reason === "shell-missing"
      ? `Login shell not found: ${this.shell}`
      : "The script's terminal could not be started.";
  }
}

export interface SpawnOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cols: number;
  readonly rows: number;
}

// How a run is stopped. `wait: false` sends the first SIGTERM and
// moves on: an update's installer is waiting on the app to exit.
export interface Stopping {
  readonly graceMs: number;
  readonly wait: boolean;
}

// What the layer's close stops a run it finds still open with.
const DEFAULT_STOPPING: Stopping = { graceMs: 3_000, wait: true };

// How long to wait for a child that survived SIGKILL (kernel-stuck
// I/O) before giving up. A delete or a quit must not hang behind it.
export const UNKILLABLE_WAIT_MS = 5_000;

export interface PtyHandle {
  readonly pid: number;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly onData: (listener: (data: string) => void) => void;
  // A read error on the PTY master, other than the EAGAIN and EIO noise
  // of a PTY closing.
  readonly onError: (listener: (error: Error) => void) => void;
  readonly onExit: (
    listener: (exit: { exitCode: number; signal?: number | undefined }) => void,
  ) => void;
}

// $SHELL is reliable when launched from a terminal, but can be empty in
// GUI launches depending on launchd state. os.userInfo().shell reads the
// passwd entry directly. We use a *login* shell (no `-i`) so the user's
// `.zprofile` / `.bash_profile` runs without zsh's interactive-init code
// (job control, prompt setup, zle) getting in the way of the command.
function resolveShell(): { command: string; args: string[] } {
  const userShell = envSetting("SHELL") || userInfo().shell;
  if (userShell) return { command: userShell, args: ["-l", "-c"] };
  return { command: "/bin/sh", args: ["-c"] };
}

// Inherited terminal state that would mislead a program in the new
// PTY: the app may itself have been launched from a tmux pane or a
// shell exporting its own size. node-pty strips the same set, but only
// when handed process.env itself, not a copy with additions.
const STALE_TERMINAL_ENV = new Set([
  "COLUMNS",
  "LINES",
  "TERMCAP",
  "WINDOWID",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
]);

const pty = Effect.fn("Pty.spawn")(function* (
  opts: SpawnOptions,
  stopping: () => Stopping,
) {
  const { command: shell, args: shellArgs } = resolveShell();
  // node-pty's helper execs the shell in the child and exits 1 without
  // a word if that fails, which would show as a bare "exit 1".
  if (!existsSync(shell)) {
    return yield* new PtySpawnError({
      shell,
      reason: "shell-missing",
      cause: undefined,
    });
  }
  // node-pty's env is a plain string map, so the undefined entries
  // NodeJS.ProcessEnv allows are dropped.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (value !== undefined && !STALE_TERMINAL_ENV.has(key)) {
      env[key] = value;
    }
  }
  const exited = yield* Deferred.make<{
    exitCode: number;
    signal: number | undefined;
  }>();
  const exit = Deferred.await(exited);
  const waitExit = (ms: number) =>
    exit.pipe(
      Effect.timeoutOption(Duration.millis(ms)),
      Effect.map(Option.isSome),
    );
  // The PTY child runs in its own session, so its pgid === pid and the
  // whole tree is signaled through -pid.
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: (): IPty => {
        const spawned = spawnPty(shell, [...shellArgs, opts.command], {
          name: "xterm-256color",
          cols: opts.cols,
          rows: opts.rows,
          cwd: opts.cwd,
          env,
        });
        // node-pty's type leaves the emitter out (the terminal has one
        // of its own, not node's), so the method onError needs is
        // checked for, not assumed.
        if (!("on" in spawned) || typeof spawned.on !== "function") {
          spawned.kill();
          throw new Error("node-pty's terminal no longer emits events");
        }
        return spawned;
      },
      catch: (cause) => new PtySpawnError({ shell, reason: "failed", cause }),
    }),
    (spawned) =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(exited)) return;
        const { graceMs, wait } = stopping();
        if (!wait) {
          signalTreeBestEffort(spawned.pid, "SIGTERM");
          return;
        }
        yield* signalTree(spawned.pid, "SIGTERM");
        if (yield* waitExit(graceMs)) return;
        yield* signalTree(spawned.pid, "SIGKILL");
        if (yield* waitExit(UNKILLABLE_WAIT_MS)) return;
        yield* Effect.logWarning(
          `[scripts] "${opts.command}" (pid ${spawned.pid}) survived SIGKILL, giving up on it`,
        );
      }),
  );
  // node-pty reports exit only after the terminal stream has drained
  // (or a short grace period when a backgrounded grandchild still holds
  // the PTY open), so the run's last output never races its exit.
  child.onExit(({ exitCode, signal }) => {
    Deferred.doneUnsafe(exited, Exit.succeed({ exitCode, signal }));
  });
  const on = (child as IPty & { on: (...args: never[]) => void }).on.bind(
    child,
  ) as (
    event: "error",
    listener: (error: NodeJS.ErrnoException) => void,
  ) => void;
  return {
    pid: child.pid,
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
    onData: (listener) => void child.onData(listener),
    // A read error on the PTY master is rethrown by node-pty unless
    // someone else listens for it, and an uncaught throw here takes the
    // whole main process down. This listener sits on the same socket as
    // node-pty's own, so it sees the EAGAIN/EIO noise that one filters
    // as part of a normal PTY lifecycle and must skip it too. node-pty
    // closes the PTY first, so the exit event follows a real error.
    onError: (listener) =>
      on("error", (error) => {
        const code = error.code ?? "";
        if (code.includes("EAGAIN") || code.includes("EIO")) return;
        listener(new Error(errorMessageOf(error)));
      }),
    onExit: (listener) => void child.onExit(listener),
  } satisfies PtyHandle;
});

// Every run the app spawned, each in a scope under the layer's, so the
// quit ends whatever the quit's own policy (host/process/layer.ts) left.
export class ScriptRuns extends Context.Service<
  ScriptRuns,
  {
    // A PTY run in a scope of its own, and how to close it: the kill
    // chain under the stopping it is given.
    readonly open: (opts: SpawnOptions) => Effect.Effect<
      {
        readonly pty: PtyHandle;
        readonly close: (stopping: Stopping) => Effect.Effect<void>;
      },
      PtySpawnError
    >;
  }
>()("sm/host/ScriptRuns") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const open = Effect.fn("ScriptRuns.open")(function* (opts: SpawnOptions) {
    const run = yield* Scope.fork(scope);
    // Read by the release: the stopping the close was given, or the
    // default when the layer closes the run.
    let stopping = DEFAULT_STOPPING;
    const handle = yield* pty(opts, () => stopping).pipe(
      Scope.provide(run),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.onError(() => Scope.close(run, Exit.void)),
    );
    // The stopping is taken when close is called, not when its effect
    // runs: a hurried quit's close reaches the run through the adapter
    // a moment later, and the layer's own close may come first.
    const close = (given: Stopping) => {
      stopping = given;
      return Scope.close(run, Exit.void);
    };
    return { pty: handle, close };
  });
  return ScriptRuns.of({ open });
});

export const layer = Layer.effect(ScriptRuns, make);

// For index.ts, whose callers are not Effect yet.
const promiseAdapter = PromiseAdapter.make<ScriptRuns>("The scripts");
export const adapter = promiseAdapter.layer;

const onRuns = <A, E>(
  f: (runs: ScriptRuns["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* f(yield* ScriptRuns);
  });

// A run started from a synchronous caller: the spawn is synchronous, so
// the run exists when this returns. Throws what the spawn threw.
export function openRun(opts: SpawnOptions): {
  pty: PtyHandle;
  close: (stopping: Stopping) => Promise<void>;
} {
  const opened = promiseAdapter.runSyncOr(
    onRuns((runs) => runs.open(opts)).pipe(Effect.result),
    () => {
      throw new Error("The app is still starting; try the script again.");
    },
  );
  if (Result.isFailure(opened)) {
    if (opened.failure.reason === "failed") {
      log.warn(
        `[scripts] the PTY did not start: ${errorMessageOf(opened.failure.cause)}`,
      );
    }
    throw opened.failure;
  }
  const { pty: handle, close } = opened.success;
  return {
    pty: handle,
    close: (stopping) => promiseAdapter.run(close(stopping)),
  };
}
