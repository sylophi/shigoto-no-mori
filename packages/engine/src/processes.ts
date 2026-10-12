// What the engine asks of the processes on this machine: whether one
// is alive, and running a command to its end, keeping what it said.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

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
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          stdin: "ignore",
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
