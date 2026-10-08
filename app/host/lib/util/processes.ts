// One-shot commands through effect/process: run a binary to its exit
// and read what it printed. Each runs in a scope, so a timeout or an
// interrupted caller ends the command with its process group. The
// long-lived children (cloudflared, the file-sync daemon, the scripts)
// hold their handles themselves.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PromiseAdapter from "./promiseAdapter";

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

// What the command wrote to stderr, for a caller that relays it.
export const stderrOf = (error: CommandError): string =>
  error.cause instanceof Error && error.reason === "failed"
    ? error.cause.message
    : "";

// The spawn itself failed because the binary is not there.
const isNotFound = (error: PlatformError.PlatformError): boolean =>
  Predicate.isTagged(error.reason, "NotFound") &&
  error.reason.module === "ChildProcess";

const decoder = new TextDecoder();

// Node's execFile default, which every caller here grew up with.
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

interface Read {
  readonly chunks: Uint8Array[];
  size: number;
}

// Reads a pipe to its end. Past `limit` bytes it fails with `tooLarge`,
// or without one keeps the first `limit` bytes and drains the rest.
const readAll = <E, E2 = never>(
  stream: Stream.Stream<Uint8Array, E>,
  limit: number,
  tooLarge?: () => E2,
): Effect.Effect<string, E | E2> =>
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
      return decoder.decode(all);
    }),
  );

export interface ExecOptions {
  readonly cwd?: string | undefined;
  // The whole environment of the command. The app's own when absent.
  readonly env?: Record<string, string | undefined> | undefined;
  readonly timeout?: Duration.Input | undefined;
  readonly maxOutputBytes?: number | undefined;
}

// Runs `command` to its exit. Anything but exit 0 fails, with stderr
// as the cause.
export const exec = Effect.fn("exec")(function* (
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const name = command.slice(command.lastIndexOf("/") + 1);
  yield* Effect.annotateCurrentSpan({ command: name });
  const fail =
    (reason: CommandError["reason"], exitCode: number | null = null) =>
    (cause: unknown) =>
      new CommandError({ command: name, reason, exitCode, cause });
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const run = Effect.gen(function* () {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          fail(isNotFound(error) ? "not-found" : "failed")(error),
        ),
      );
    const [stdout, stderr] = yield* Effect.all(
      [
        readAll(
          handle.stdout.pipe(Stream.mapError(fail("failed"))),
          limit,
          () => fail("too-large")(undefined),
        ),
        readAll(handle.stderr.pipe(Stream.mapError(fail("failed"))), limit),
      ],
      { concurrency: 2 },
    );
    const code = yield* handle.exitCode.pipe(Effect.mapError(fail("failed")));
    if (code !== 0) {
      return yield* fail("failed", code)(new Error(stderr.trim()));
    }
    return { stdout, stderr };
  }).pipe(Effect.scoped);
  if (options.timeout === undefined) return yield* run;
  return yield* run.pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () => Effect.fail(fail("timed-out")(undefined)),
    }),
  );
});

// The resolved path of a binary on PATH, or null. The packaged app's
// PATH is the login shell's (main/core/shellEnv.ts), so anything
// installed for the user's terminal is found here too.
export const resolveOnPath = (name: string) =>
  exec("which", [name]).pipe(
    Effect.map(({ stdout }) => stdout.trim() || null),
    Effect.orElseSucceed(() => null),
  );

// For the callers that are not Effect yet. Its layer goes at the bottom
// of the host graph, over the platform's.
export const { layer: adapter, run } =
  PromiseAdapter.make<ChildProcessSpawner.ChildProcessSpawner>(
    "The host's child processes",
  );
