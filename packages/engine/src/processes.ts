// What the engine and the host ask of the processes on this machine:
// whether one is alive, and running a command to its end, keeping what
// it said. Each command runs in a scope, so a timeout or an interrupted
// caller ends it with its process group. The long-lived children
// (cloudflared, the file-sync daemon, the scripts) hold their handles
// themselves.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { startOnWindows } from "./batchFiles.ts";
import { findOn } from "./executables.ts";
import { keptAnswers } from "./keptAnswers.ts";
import { byPlatform } from "./platform.ts";
import { isMissingProgram } from "./platformErrors.ts";
import * as Shells from "./Shells.ts";
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

// Windows starts a batch file only through cmd (startable), and Node
// finds a bare name only as an .exe or a .com, past a batch file
// earlier on PATH, so a bare name is found as cmd finds it, on the
// child's PATH (startOnWindows). Looked up again each minute, for a
// program installed or removed meanwhile.
const windowsSpawner = Effect.fnUntraced(function* (
  inner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const found = yield* keptAnswers(
    ([searched, name]: readonly [string, string]) => findOn(searched, name),
    "1 minute",
  );
  return (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* inner.spawn(command);
      }
      const searched =
        command.options.env?.["PATH"] ?? process.env["PATH"] ?? "";
      const started = yield* startOnWindows(
        (name) => found.get([searched, name]),
        command.command,
        command.args,
      );
      return yield* inner.spawn(
        ChildProcess.make(started.command, started.args, {
          ...command.options,
          shell: started.shell,
        }),
      );
    });
});

// The platform's spawner with those defaults, provided once by each
// graph that spawns: the engine's (`layer.ts`) and the host's.
export const childDefaults = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const inner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawn = yield* byPlatform({
      darwin: Effect.succeed(inner.spawn),
      linux: Effect.succeed(inner.spawn),
      win32: windowsSpawner(inner),
    });
    return ChildProcessSpawner.make((command) => spawn(withDefaults(command)));
  }),
);

// Whether a process with the pid exists, whoever owns it. Signal 0
// delivers nothing but still checks that the process exists, and EPERM
// means it exists and isn't ours.
export const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === "EPERM";
  }
};

export const pidAlive = (pid: number) => Effect.sync(() => isPidAlive(pid));

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

// The shell captureToFiles runs its command under, which opens the
// files and says the command's exit status on its own stdout, a pipe
// nothing the command starts holds: `sh -c FILES_SCRIPT <stdout file>
// <stderr file> command ...args`.
export const FILES_SCRIPT = 'err=$1; shift; "$@" >>"$0" 2>>"$err"; echo $?';

// Git Bash's sh rewrites an argument that reads as a POSIX path (a
// commit message `/fix the docs`) for a program not its own, as git is.
// One named in MSYS2_ARG_CONV_EXCL, a list of prefixes, stays as it is.
// The hooks the command runs inherit it, and still have their own
// rewritten unless one starts as one of these.
const keptArguments = (args: ReadonlyArray<string>) =>
  byPlatform({
    darwin: {},
    linux: {},
    win32: {
      MSYS2_ARG_CONV_EXCL: args.filter((arg) => arg.includes("/")).join(";"),
    },
  });

// A command with its output in files, not pipes, read at its exit to
// the size each had then: for one that runs the person's hooks. What a
// hook leaves in the background (a post-checkout `pnpm install &`)
// holds nothing of this process's, writes on into them unread, and runs
// on after the command's exit, whatever its status, as in a terminal.
// An interrupt or a timeout still ends the command's group. `all` takes
// both streams as one, in the order written, as `stdout`.
export const captureToFiles = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly all?: boolean;
    readonly cwd?: string;
    // A variable set to undefined is unset.
    readonly env?: Record<string, string | undefined> | undefined;
    readonly stdin?: Stream.Stream<Uint8Array>;
    // Stderr as it is written, for a command that reports its progress
    // there (a clone). It is still read whole at the exit.
    readonly onStderr?:
      | ((chunk: Uint8Array) => Effect.Effect<void>)
      | undefined;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const shells = yield* Shells.Shells;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sm-run-" });
      const out = `${dir}/out`;
      const err = options.all === true ? out : `${dir}/err`;
      const { onStderr } = options;
      // There before the shell opens it, for the tail to open first.
      if (onStderr !== undefined) yield* fs.writeFile(err, new Uint8Array());
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          yield* shells.sh,
          Shells.shArgs(FILES_SCRIPT, [out, err, command, ...args]),
          {
            stdin: options.stdin ?? "ignore",
            stderr: "ignore",
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            env: { ...options.env, ...keptArguments([command, ...args]) },
            extendEnv: true,
          },
        ),
      );
      const exited = Effect.gen(function* () {
        const said = yield* text(handle.stdout);
        yield* handle.exitCode;
        return said;
      });
      const said = (
        onStderr === undefined
          ? yield* exited
          : yield* fileUntilExit(err, exited, onStderr)
      ).trim();
      // A shell that ended before saying failed.
      const code = said === "" ? 1 : Number(said);
      const sizeOf = (file: string) =>
        Effect.map(fs.stat(file), ({ size }) => Number(size));
      const [outSize, errSize] = yield* Effect.all([sizeOf(out), sizeOf(err)]);
      // The shell exited 0, which the spawner's release would end the
      // group for.
      yield* Effect.asVoid(handle.unref);
      const stdout = (yield* fs.readFile(out)).subarray(0, outSize);
      const stderr =
        options.all === true
          ? new Uint8Array()
          : (yield* fs.readFile(err)).subarray(0, errSize);
      return { stdout, stderr, code };
    }),
  );

// How often a running script's output file is read for what it added.
const TAIL_EVERY = "50 millis";
const TAIL_CHUNK = 64 * 1024;

// A script's output file read as it grows, each chunk to `onChunk`,
// until `exit` answers, then to the size it had then: what the script
// wrote before it exited is all there, so nothing it said is lost and
// no timer decides, and a child it left in the background, which holds
// the file and not a pipe of this process, writes on into it unread.
export const fileUntilExit = <A, E, R>(
  path: string,
  exit: Effect.Effect<A, E, R>,
  onChunk: (chunk: Uint8Array) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      let read = 0;
      // One read and its report together, so stopping the tail between
      // two never loses a chunk read.
      const step = (upTo: number) =>
        Effect.uninterruptible(
          Effect.flatMap(
            file.readAlloc(Math.min(TAIL_CHUNK, upTo - read)),
            (chunk) => {
              if (Option.isNone(chunk) || chunk.value.length === 0) {
                return Effect.succeed(false);
              }
              read += chunk.value.length;
              return Effect.as(onChunk(chunk.value), read < upTo);
            },
          ),
        );
      const readTo = (upTo: number) =>
        read < upTo
          ? step(upTo).pipe(Effect.repeat({ while: (more) => more }))
          : Effect.void;
      const tail = yield* readTo(Infinity).pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(TAIL_EVERY)),
        Effect.forkScoped,
      );
      const exited = yield* Effect.exit(exit);
      yield* Fiber.interrupt(tail);
      yield* readTo(Number((yield* file.stat).size));
      return yield* exited;
    }),
  );

// A command in a process group of its own (the spawner's default),
// `read` (its pipes, read to their end) and its exit code. Its exit ends
// the group: a child it left running (a hook's under git, or an app an
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
    // Nothing left to end is no failure. Windows keeps no group to end
    // once the command is gone, whose pid may be another process's by
    // then, which the spawner's taskkill would end with its tree.
    const endGroup = handle
      .kill({ forceKillAfter: KILL_GRACE })
      .pipe(Effect.ignore);
    yield* byPlatform({
      darwin: endGroup,
      linux: endGroup,
      win32: Effect.void,
    });
    return { read: yield* Fiber.join(reading), code: Number(code) };
  });

// A command that did not answer. `cause` holds what it said on stderr,
// or the spawn failure. `command` is the binary's name, never its
// arguments, which can carry a path or a query. `seconds` is a timed-out
// command's limit.
export class CommandError extends Schema.TaggedError<CommandError>()(
  "CommandError",
  {
    command: Schema.String,
    reason: Schema.Literals(["not-found", "timed-out", "too-large", "failed"]),
    exitCode: Schema.NullOr(Schema.Int),
    seconds: Schema.optional(Schema.Finite),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `${this.command} is not installed.`;
      case "timed-out":
        return `${this.command} didn't finish within ${this.seconds} s.`;
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
  // Past it stdout fails the command, and stderr or `all` is cut short.
  readonly maxOutputBytes?: number | undefined;
  // Both streams as one, in the order written, as `stdout`.
  readonly all?: boolean | undefined;
  // Any exit answers, with its code.
  readonly anyExit?: boolean | undefined;
}

// Runs `command` to its exit. Anything but exit 0 fails with what it
// wrote as the cause (stderrOf, stdoutOf), unless `anyExit`.
export const exec = Effect.fn("exec")(function* (
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Effect.fn.Return<
  { readonly stdout: string; readonly stderr: string; readonly code: number },
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
  const timeout = Duration.fromInputUnsafe(
    options.timeout ?? Duration.infinity,
  );
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
      options.all === true
        ? Effect.all([readAll(handle.all, limit), Effect.succeed("")])
        : Effect.all(
            [
              readAll(handle.stdout, limit, {
                tooLarge: () => fail("too-large", undefined),
              }),
              readAll(handle.stderr, limit),
            ],
            { concurrency: 2 },
          ),
    );
    if (code !== 0 && options.anyExit !== true) {
      return yield* fail(
        "failed",
        new ExitedError(stderr.trim(), stdout),
        code,
      );
    }
    return { stdout, stderr, code };
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      isCommandError(error)
        ? error
        : fail(isMissingProgram(error) ? "not-found" : "failed", error),
    ),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new CommandError({
            command: name,
            reason: "timed-out",
            exitCode: null,
            seconds: Duration.toSeconds(timeout),
            cause: undefined,
          }),
        ),
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
export const working = exec("lsof", ["-n", "-w", "+c0", "-d", "cwd", "-Fpcn"], {
  cwd: "/",
  timeout: "10 seconds",
  anyExit: true,
}).pipe(
  Effect.flatMap(({ stdout, code }) => {
    // lsof exits 1 when it couldn't read some process, and still lists
    // the rest.
    if (stdout === "") return Effect.fail(new ProcessesUnlisted({ code }));
    const found: Working[] = [];
    let pid = 0;
    let command = "";
    for (const line of stdout.split("\n")) {
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
