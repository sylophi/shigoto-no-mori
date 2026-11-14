// Script runs under a pseudo-terminal (node-pty), each a resource in a
// scope of its own under the ScriptRuns layer's.
//
// Scripts run in a PTY rather than on pipes, so the console behaves
// like a terminal: programs see a TTY, get a real window size, emit
// color without coaxing, and can read keystrokes the renderer forwards
// (interactive prompts, vite's "r"/"q" shortcuts, TUIs). node-pty is not
// a child_process, so this is the wrapper that gives a PTY child the
// shape of an effect/process one: acquired in a scope, its release the
// kill chain (./ProcessTrees.ts), its exit an effect to wait on.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { type IPty, spawn as spawnPty } from "node-pty";
import { messageOf } from "@shigomori/engine/errorDocument";
import * as Shells from "@shigomori/engine/Shells";
import * as ProcessTrees from "./ProcessTrees";

// No process could be started: a missing folder to start in or login
// shell, or a PTY that could not be allocated. The console shows the
// message.
export class PtySpawnError extends Schema.TaggedError<PtySpawnError>()(
  "PtySpawnError",
  {
    shell: Schema.String,
    cwd: Schema.String,
    reason: Schema.Literals(["cwd-missing", "shell-missing", "failed"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "cwd-missing":
        return `Worktree directory is missing: ${this.cwd}`;
      case "shell-missing":
        return `Login shell not found: ${this.shell}`;
      case "failed":
        return "The script's terminal could not be started.";
    }
  }
}

export interface SpawnOptions {
  readonly shell: Shells.Shell;
  // What the shell runs, or null for the shell itself, interactive (a
  // terminal's).
  readonly command: string | null;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cols: number;
  readonly rows: number;
}

// How a run is stopped. `wait: false` asks it to stop and moves on: an
// update's installer is waiting on the app to exit. The ask is a stop
// unless `how` says otherwise: an interactive shell ignores a stop and
// ends on a hangup, as when its terminal window closes.
export interface Stopping {
  readonly graceMs: number;
  readonly wait: boolean;
  readonly how?: "stop" | "hangup";
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
  // Stops and restarts reading the PTY, so a program writing faster
  // than its output is taken blocks, as it would in any terminal.
  readonly pause: () => void;
  readonly resume: () => void;
  readonly onData: (listener: (data: string) => void) => void;
  // A read error on the PTY master, other than the EAGAIN and EIO noise
  // of a PTY closing.
  readonly onError: (listener: (error: Error) => void) => void;
  readonly onExit: (
    listener: (exit: { exitCode: number; signal?: number | undefined }) => void,
  ) => void;
  // The child's exit, once it has drained its output.
  readonly exit: Effect.Effect<unknown>;
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

export const spawn = Effect.fn("Pty.spawn")(function* (
  opts: SpawnOptions,
  stopping: () => Stopping,
) {
  const { program, args } = opts.shell;
  // node-pty's helper does the chdir and execs the shell in the child,
  // and exits 1 without a word if either fails, which would show as a
  // bare "exit 1".
  const fs = yield* FileSystem.FileSystem;
  const exists = (path: string) =>
    fs.exists(path).pipe(Effect.orElseSucceed(() => false));
  const missing = !(yield* exists(opts.cwd))
    ? "cwd-missing"
    : !(yield* exists(program))
      ? "shell-missing"
      : null;
  if (missing !== null) {
    return yield* new PtySpawnError({
      shell: program,
      cwd: opts.cwd,
      reason: missing,
      cause: undefined,
    });
  }
  // node-pty's env is a plain string map, so the undefined entries
  // NodeJS.ProcessEnv allows are dropped.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...opts.env,
    ...opts.shell.env,
  })) {
    if (value !== undefined && !STALE_TERMINAL_ENV.has(key)) {
      env[key] = value;
    }
  }
  const trees = yield* ProcessTrees.ProcessTrees;
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
  // The PTY child runs in its own session, so it leads its own group.
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: (): IPty => {
        const spawned = spawnPty(
          program,
          opts.command === null
            ? [...args]
            : [...args, ...Shells.shArgs(opts.command, [])],
          {
            name: "xterm-256color",
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env,
          },
        );
        // node-pty's type leaves the emitter out (the terminal has one
        // of its own, not node's), so the method onError needs is
        // checked for, not assumed.
        if (!("on" in spawned) || typeof spawned.on !== "function") {
          spawned.kill();
          throw new Error("node-pty's terminal no longer emits events");
        }
        return spawned;
      },
      catch: (cause) =>
        new PtySpawnError({
          shell: program,
          cwd: opts.cwd,
          reason: "failed",
          cause,
        }),
    }),
    (spawned) => {
      // Once only: a pseudoconsole closed twice is freed twice.
      let open = true;
      const tree = {
        pid: spawned.pid,
        ownGroup: true,
        closeTerminal: () => {
          if (open) spawned.kill();
          open = false;
        },
        interrupt: () => spawned.write("\x03"),
      };
      return Effect.gen(function* () {
        if (yield* Deferred.isDone(exited)) return;
        const { graceMs, wait, how = "stop" } = stopping();
        if (!wait) return yield* trees.askNow(tree);
        yield* trees.ask(tree, how);
        if (yield* waitExit(graceMs)) return;
        yield* trees.end(tree);
        if (yield* waitExit(UNKILLABLE_WAIT_MS)) return;
        yield* Effect.logWarning(
          `[scripts] "${opts.command ?? program}" (pid ${spawned.pid}) survived SIGKILL, giving up on it`,
        );
      }).pipe(Effect.ensuring(trees.release(tree)));
    },
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
    pause: () => child.pause(),
    resume: () => child.resume(),
    onData: (listener) => void child.onData(listener),
    // A read error on the PTY master is rethrown by node-pty unless
    // someone else listens for it, and an uncaught throw here takes the
    // whole host process down. This listener sits on the same socket as
    // node-pty's own, so it sees the EAGAIN/EIO noise that one filters
    // as part of a normal PTY lifecycle and must skip it too. node-pty
    // closes the PTY first, so the exit event follows a real error.
    onError: (listener) =>
      on("error", (error) => {
        const code = error.code ?? "";
        if (code.includes("EAGAIN") || code.includes("EIO")) return;
        listener(new Error(messageOf(error)));
      }),
    onExit: (listener) => void child.onExit(listener),
    exit,
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
  const trees = yield* ProcessTrees.ProcessTrees;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const open = Effect.fn("ScriptRuns.open")(function* (opts: SpawnOptions) {
    const run = yield* Scope.fork(scope);
    // Read by the release: the stopping the close was given, or the
    // default when the layer closes the run.
    let stopping = DEFAULT_STOPPING;
    const handle = yield* spawn(opts, () => stopping).pipe(
      Scope.provide(run),
      Effect.provideService(ProcessTrees.ProcessTrees, trees),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.onError(() => Scope.close(run, Exit.void)),
    );
    // The stopping is taken when close is called, not when its effect
    // runs: the layer's own close may come first.
    const close = (given: Stopping) => {
      stopping = given;
      return Scope.close(run, Exit.void);
    };
    // A run that is over lets go of its scope, so the layer stops
    // holding it. The release finds the child exited and signals
    // nothing.
    yield* handle.exit.pipe(
      Effect.andThen(() => close({ graceMs: 0, wait: false })),
      Effect.forkIn(scope),
    );
    return { pty: handle, close };
  });
  return ScriptRuns.of({ open });
});

export const layer = Layer.effect(ScriptRuns, make);
