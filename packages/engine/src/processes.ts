// What the engine and the host ask of the processes on this machine:
// whether one is alive, and running a command to its end, keeping what
// it said. Each command runs in a scope, so a timeout or an interrupted
// caller ends it with its process group. The long-lived children
// (cloudflared, the file-sync daemon, the scripts) hold their handles
// themselves.
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { isMissingProgram } from "./platformErrors.ts";

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

// How long ago `pid` started, in seconds, from ps's elapsed time
// ([[dd-]hh:]mm:ss); none when ps can't say.
const ageOf = (pid: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ran = yield* captureWithin(
      spawner,
      "ps",
      ["-o", "etime=", "-p", String(pid)],
      "5 seconds",
    ).pipe(Effect.option);
    if (Option.isNone(ran) || ran.value.code !== 0)
      return Option.none<number>();
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(
      ran.value.output.trim(),
    );
    if (match === null) return Option.none<number>();
    const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
    return Option.some(
      ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 +
        Number(seconds),
    );
  });

// When `pid` started, in this machine's milliseconds, to the second;
// none when ps can't say.
export const startOf = (pid: number) =>
  Effect.gen(function* () {
    const age = yield* ageOf(pid);
    const now = yield* Clock.currentTimeMillis;
    return Option.map(age, (seconds) => now - seconds * 1000);
  });

// Whether the process that recorded itself as `pid`, started at
// `startedAt`, still runs: a live pid that started at another time is
// another process the system handed the number to since.
export const stillRunning = (pid: number, startedAt: number) =>
  Effect.gen(function* () {
    if (pid < 2 || !(yield* pidAlive(pid))) return false;
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
    readonly env?: Record<string, string> | undefined;
    readonly cwd?: string;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          stdin: "ignore",
          // A command that ignores the scope's SIGTERM is killed after
          // this, so a deadline is one.
          forceKillAfter: "3 seconds",
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined
            ? {}
            : { env: options.env, extendEnv: true }),
        }),
      );
      const all = options.from === "all";
      const [output, , code] = yield* Effect.all(
        [
          text(all ? handle.all : handle.stdout),
          all ? Effect.void : Stream.runDrain(handle.stderr),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { output, code: Number(code) };
    }),
  );

// `capture`, ended past `timeout` (its scope closes, so the command goes
// with it) and failed.
export const captureWithin = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input,
  options: {
    readonly from?: "stdout" | "all";
    readonly env?: Record<string, string> | undefined;
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
        // A timeout's SIGTERM is waited on, so one ignored still ends.
        forceKillAfter: "3 seconds",
      }),
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        readAll(handle.stdout, limit, {
          tooLarge: () => fail("too-large", undefined),
        }),
        readAll(handle.stderr, limit),
      ],
      { concurrency: 2 },
    );
    const code = yield* handle.exitCode;
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

// The resolved path of a binary on PATH, or null. The packaged app's
// PATH is the login shell's (shared/shellEnv.ts), so anything
// installed for the user's terminal is found here too.
export const resolveOnPath = (name: string) =>
  exec("which", [name]).pipe(
    Effect.map(({ stdout }) => stdout.trim() || null),
    Effect.orElseSucceed(() => null),
  );
