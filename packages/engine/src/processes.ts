// What the engine and the host ask of the processes on this machine:
// whether one is alive, and running a command to its end, keeping what
// it said. Each command runs in a scope, so a timeout or an interrupted
// caller ends it with its process group. The long-lived children
// (cloudflared, the file-sync daemon, the scripts) hold their handles
// themselves.
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { isMissingProgram } from "./platformErrors.ts";
import { CD_FILE_ENV } from "./shellHook.ts";

// How long a child has after its SIGTERM before it is SIGKILLed. Given
// none, the platform's spawner waits a second and then on the exit for
// good, so a child that ignores SIGTERM (a user's hook, a stuck helper)
// held its caller's interrupt or timeout forever.
export const KILL_GRACE = "3 seconds";

// A child's environment: `env` less the shell hook's directive file,
// which is the terminal `sm`'s alone (an editor or a hook writing it
// would move the user's shell).
export const childEnv = (
  env: Readonly<Record<string, string | undefined>> | undefined,
) => ({ ...env, [CD_FILE_ENV]: undefined });

// What every child gets that its command doesn't say otherwise:
// KILL_GRACE and childEnv.
const withDefaults = (command: ChildProcess.Command): ChildProcess.Command =>
  ChildProcess.isStandardCommand(command)
    ? ChildProcess.make(command.command, command.args, {
        ...command.options,
        forceKillAfter: command.options.forceKillAfter ?? KILL_GRACE,
        env: childEnv(command.options.env),
        extendEnv:
          command.options.env === undefined || command.options.extendEnv,
      })
    : command;

// The platform's spawner with those defaults, provided once by each
// graph that spawns: the engine's (`layer.ts`) and the host's.
export const childDefaults = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, (inner) =>
    ChildProcessSpawner.make((command) => inner.spawn(withDefaults(command))),
  ),
);

// Signal 0 delivers nothing but still checks that the process exists.
// EPERM means it exists and isn't ours.
const signalZero = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === "EPERM";
  }
};

// Whether a process with the pid exists, whoever owns it.
export const pidAlive = (pid: number) => Effect.sync(() => signalZero(pid));

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// ps's `lstart` ("Sat Oct 17 03:21:24 2026"), as ps prints it under
// PS_BIRTH_ENV, in epoch milliseconds; none for anything else.
export const parseLstart = (text: string): Option.Option<number> => {
  const match =
    /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
      text.trim(),
    );
  if (match === null) return Option.none();
  const [, month = "", day, hours, minutes, seconds, year] = match;
  const index = MONTHS.indexOf(month);
  if (index < 0) return Option.none();
  return Option.some(
    DateTime.toEpochMillis(
      DateTime.makeUnsafe({
        year: Number(year),
        month: index + 1,
        day: Number(day),
        hour: Number(hours),
        minute: Number(minutes),
        second: Number(seconds),
      }),
    ),
  );
};

// What `ps -o lstart` runs under: UTC, so a zone or a daylight-saving
// change doesn't move a birth, and C, so its names are English.
export const PS_BIRTH_ENV = { TZ: "UTC", LC_ALL: "C" };

// When `pid` was born, in epoch milliseconds to the second: the stamp
// the kernel took at its fork, which no later clock step moves. None
// when ps can't say.
export const startOf = (pid: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ran = yield* captureWithin(
      spawner,
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      "5 seconds",
      { env: PS_BIRTH_ENV },
    ).pipe(Effect.option);
    if (Option.isNone(ran) || ran.value.code !== 0)
      return Option.none<number>();
    return parseLstart(ran.value.output);
  });

// A record's birth when the process that wrote it couldn't read its own.
export const UNKNOWN_BIRTH = 0;

// Whether the process that recorded itself as `pid`, born at
// `startedAt`, still runs: a live pid born at another time is another
// process the system handed the number to since. A birth unknown on
// either side counts as the same process, so nothing takes over the
// work of an owner it can't tell is gone.
export const stillRunning = (pid: number, startedAt: number) =>
  Effect.gen(function* () {
    if (pid < 2 || !(yield* pidAlive(pid))) return false;
    if (startedAt === UNKNOWN_BIRTH) return true;
    const started = yield* startOf(pid);
    // A few seconds' slack: ps counts in whole seconds.
    return (
      Option.isNone(started) || Math.abs(started.value - startedAt) <= 5000
    );
  });

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

// A command that ran past its deadline, and was ended.
export class CommandTimedOut extends Schema.TaggedError<CommandTimedOut>()(
  "CommandTimedOut",
  { command: Schema.String, seconds: Schema.Finite },
) {
  override get message(): string {
    return `${this.command} didn't finish within ${this.seconds} s.`;
  }
}

// The exit code, and stdout or, with `from: "all"`, both streams as the
// command interleaved them. The stream not kept is still drained, so a
// command that says a lot there never stalls on a full pipe.
export const capture = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly from?: "stdout" | "all";
    // A variable set to undefined is unset.
    readonly env?: Record<string, string | undefined> | undefined;
    readonly cwd?: string;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          stdin: "ignore",
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined
            ? {}
            : { env: options.env, extendEnv: true }),
        }),
      );
      const all = options.from === "all";
      const {
        read: [output],
        code,
      } = yield* readToExit(
        handle,
        Effect.all(
          [
            text(all ? handle.all : handle.stdout),
            all ? Effect.void : Stream.runDrain(handle.stderr),
          ],
          { concurrency: 2 },
        ),
      );
      return { output, code };
    }),
  );

// How long output may still arrive after its process's exit and count:
// Node can report the exit before the last of what was written.
const EXIT_DRAIN = "200 millis";

// A process's output until it exits, each chunk to `onChunk`, then its
// `exit`, for a script whose background children outlive it (a
// lifecycle script, in this process's group): one inherits its pipes and
// can hold them open for good, so the exit ends the read, not the pipes'
// end. The reader runs in `scope` and drops what comes after, so a child
// that outlives the read keeps a reader until it closes the pipe or
// `scope` ends.
export const outputUntilExit = <A, E, R>(
  output: Stream.Stream<Uint8Array, unknown>,
  exit: Effect.Effect<A, E, R>,
  onChunk: (chunk: Uint8Array) => Effect.Effect<void>,
  scope: Scope.Scope,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const reading = yield* Ref.make(true);
    // A chunk is handed on whole or not at all once the read ends.
    const turn = yield* Semaphore.make(1);
    const reader = yield* output.pipe(
      Stream.runForEach((chunk) =>
        turn.withPermits(1)(
          Effect.flatMap(Ref.get(reading), (on) =>
            on ? onChunk(chunk) : Effect.void,
          ),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    return yield* Effect.gen(function* () {
      const exited = yield* Effect.exit(exit);
      // On a real clock: a TestClock never ends this wait while a child
      // holds the pipes.
      yield* Fiber.await(reader).pipe(Effect.timeoutOption(EXIT_DRAIN));
      return yield* exited;
    }).pipe(Effect.ensuring(turn.withPermits(1)(Ref.set(reading, false))));
  });

// A command in a process group of its own (the spawner's default),
// `read` (its pipes, read to their end) and its exit code. Its exit ends
// the group: a child it left running (a hook's, under git; an app an
// editor's command started) would otherwise hold the pipes open for
// good. What the command wrote before it exited is all still read.
export const readToExit = <A, E, R>(
  handle: ChildProcessSpawner.ChildProcessHandle,
  read: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const reading = yield* Effect.forkScoped(read);
    // A read that fails (past its cap) fails it at once: the command may
    // be blocked writing to a pipe no one reads.
    const code = yield* Effect.raceFirst(
      handle.exitCode,
      Effect.andThen(Fiber.join(reading), Effect.never),
    );
    // Nothing left to end is no failure.
    yield* handle.kill({ forceKillAfter: KILL_GRACE }).pipe(Effect.ignore);
    return { read: yield* Fiber.join(reading), code: Number(code) };
  });

// `capture`, ended past `timeout` (its scope closes, so the command goes
// with it) and failed.
export const captureWithin = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input,
  options: {
    readonly from?: "stdout" | "all";
    readonly env?: Record<string, string | undefined> | undefined;
    readonly cwd?: string;
  } = {},
) =>
  capture(spawner, command, args, options).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new CommandTimedOut({
            command,
            seconds: Duration.toSeconds(Duration.fromInputUnsafe(timeout)),
          }),
        ),
    }),
  );

// A command that did not answer. `cause` holds what it said on stderr,
// or the spawn failure. `command` is the binary's name, never its
// arguments, which can carry a path or a query.
export class CommandError extends Schema.TaggedError<CommandError>()(
  "CommandError",
  {
    command: Schema.String,
    reason: Schema.Literals(["not-found", "timed-out", "too-large", "failed"]),
    exitCode: Schema.NullOr(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `${this.command} is not installed.`;
      case "timed-out":
        return `${this.command} timed out.`;
      case "too-large":
        return `${this.command} printed more than the app reads.`;
      case "failed":
        return this.exitCode === null
          ? `${this.command} did not finish.`
          : `${this.command} exited with ${this.exitCode}.`;
    }
  }
}

export const isCommandError = Schema.is(CommandError);

// A command's exit, its stderr the message and its stdout beside it.
class ExitedError extends Error {
  readonly stdout: string;
  constructor(stderr: string, stdout: string) {
    super(stderr);
    this.stdout = stdout;
  }
}

// What the command wrote to stderr, for a caller that relays it.
// Only a command that exited carries it.
export const stderrOf = (error: CommandError): string =>
  error.exitCode !== null && error.cause instanceof Error
    ? error.cause.message
    : "";

// What it wrote to stdout before it failed, for a caller that reads a
// partial answer. Only a command that exited carries it.
export const stdoutOf = (error: CommandError): string =>
  error.exitCode !== null && error.cause instanceof ExitedError
    ? error.cause.stdout
    : "";

const utf8 = new TextDecoder();

// Node's execFile default, which every caller here grew up with.
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

interface Read {
  readonly chunks: Uint8Array[];
  size: number;
}

// Reads a pipe to its end as text. Past `limit` bytes it fails with
// `tooLarge`, or without one keeps the first `limit` bytes and drains
// the rest.
export const readAll = <E, E2 = never>(
  stream: Stream.Stream<Uint8Array, E>,
  limit: number,
  {
    tooLarge,
    decoder = utf8,
  }: {
    readonly tooLarge?: () => E2;
    readonly decoder?: { readonly decode: (bytes: Uint8Array) => string };
  } = {},
): Effect.Effect<string, E | E2> =>
  readAllBytes(stream, limit, tooLarge).pipe(
    Effect.map((bytes) => decoder.decode(bytes)),
  );

// `readAll` for output that isn't text: a blob's contents.
export const readAllBytes = <E, E2 = never>(
  stream: Stream.Stream<Uint8Array, E>,
  limit: number,
  tooLarge?: () => E2,
): Effect.Effect<Uint8Array, E | E2> =>
  stream.pipe(
    Stream.runFoldEffect(
      (): Read => ({ chunks: [], size: 0 }),
      (read: Read, chunk: Uint8Array): Effect.Effect<Read, E2> => {
        if (read.size + chunk.length > limit) {
          if (tooLarge) return Effect.fail(tooLarge());
          chunk = chunk.subarray(0, Math.max(0, limit - read.size));
        }
        read.size += chunk.length;
        read.chunks.push(chunk);
        return Effect.succeed(read);
      },
    ),
    Effect.map(({ chunks, size }) => {
      const all = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
      }
      return all;
    }),
  );

interface ExecOptions {
  readonly cwd?: string | undefined;
  // The whole environment of the command, or with `extendEnv` what it
  // sets over the app's own. The app's own when absent.
  readonly env?: Record<string, string | undefined> | undefined;
  readonly extendEnv?: boolean | undefined;
  readonly timeout?: Duration.Input | undefined;
  // Past it stdout fails the command and stderr is cut short.
  readonly maxOutputBytes?: number | undefined;
}

// Runs `command` to its exit. Anything but exit 0 fails, with what it
// wrote as the cause (stderrOf, stdoutOf).
export const exec = Effect.fn("exec")(function* (
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Effect.fn.Return<
  { readonly stdout: string; readonly stderr: string },
  CommandError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const name = command.slice(command.lastIndexOf("/") + 1);
  yield* Effect.annotateCurrentSpan({ command: name });
  const fail = (
    reason: CommandError["reason"],
    cause: unknown,
    exitCode: number | null = null,
  ) => new CommandError({ command: name, reason, exitCode, cause });
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        extendEnv: options.extendEnv,
        stdin: "ignore",
      }),
    );
    const {
      read: [stdout, stderr],
      code,
    } = yield* readToExit(
      handle,
      Effect.all(
        [
          readAll(handle.stdout, limit, {
            tooLarge: () => fail("too-large", undefined),
          }),
          readAll(handle.stderr, limit),
        ],
        { concurrency: 2 },
      ),
    );
    if (code !== 0) {
      return yield* fail(
        "failed",
        new ExitedError(stderr.trim(), stdout),
        code,
      );
    }
    return { stdout, stderr };
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      isCommandError(error)
        ? error
        : fail(isMissingProgram(error) ? "not-found" : "failed", error),
    ),
    Effect.timeoutOrElse({
      duration: options.timeout ?? Duration.infinity,
      orElse: () => Effect.fail(fail("timed-out", undefined)),
    }),
  );
});

// A process and the folder it works in.
export type Working = {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
};

// lsof that said nothing and failed.
class ProcessesUnlisted extends Schema.TaggedError<ProcessesUnlisted>()(
  "ProcessesUnlisted",
  { code: Schema.Int },
) {
  override get message(): string {
    return `couldn't tell what runs in it: lsof failed (exit code ${this.code})`;
  }
}

// Every process lsof can see (the user's own) with the folder it works
// in, this one left out. lsof runs from the root, so it doesn't list
// itself in a folder it was asked about.
export const working = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  captureWithin(
    spawner,
    "lsof",
    ["-n", "-w", "+c0", "-d", "cwd", "-Fpcn"],
    "10 seconds",
    { cwd: "/" },
  ).pipe(
    Effect.flatMap(({ output, code }) => {
      // lsof exits 1 when it couldn't read some process, and still lists
      // the rest.
      if (output === "") return Effect.fail(new ProcessesUnlisted({ code }));
      const found: Working[] = [];
      let pid = 0;
      let command = "";
      for (const line of output.split("\n")) {
        const value = line.slice(1);
        if (line.startsWith("p")) pid = Number(value);
        else if (line.startsWith("c")) command = value;
        else if (line.startsWith("n") && pid !== process.pid) {
          found.push({ pid, command, cwd: value });
        }
      }
      return Effect.succeed(found as ReadonlyArray<Working>);
    }),
  );
