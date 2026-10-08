// Running a command to its end and keeping what it said.
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

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
