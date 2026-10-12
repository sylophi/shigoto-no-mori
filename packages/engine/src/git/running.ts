// Git's runner: a git process in a worktree, its spawn slots, and one index write at a time per worktree.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { subcommandOf } from "../gitParse.ts";
import {
  DEFAULT_MAX_OUTPUT,
  GitCommandError,
  GitOutputTooLargeError,
  PATHSPEC_CHUNK,
  type RunOptions,
  SPAWN_SLOTS,
  UNSLOTTED_SUBCOMMANDS,
  encoder,
  identity,
  readAll,
} from "./documents.ts";

export const makeRunning = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const slots = yield* Semaphore.make(SPAWN_SLOTS);

  const run = Effect.fn("Git.run")(function* (
    cwd: string,
    args: readonly string[],
    options: RunOptions = {},
  ) {
    const subcommand = subcommandOf(args);
    yield* Effect.annotateCurrentSpan({ subcommand, cwd });
    const failed = (exitCode: number | null) => (cause: unknown) =>
      new GitCommandError({ subcommand, exitCode, cause });
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const tooLarge = () =>
      new GitOutputTooLargeError({ subcommand, limitBytes: limit });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("git", [...args], {
              cwd,
              // LC_ALL=C pins git's messages to English, so what the
              // engine matches on and relays reads the same everywhere.
              env: { ...options.env, LC_ALL: "C" },
              extendEnv: true,
              // In a process group of its own (the spawner's default), so
              // closing the scope ends git with its hooks and its ssh.
              // That also leaves it no terminal to prompt on: a
              // credential or host-key question fails instead of waiting.
              stdin:
                options.stdin === undefined
                  ? "ignore"
                  : Stream.make(encoder.encode(options.stdin)),
            }),
          )
          .pipe(Effect.mapError(failed(null)));
        const [stdout, stderr] = yield* Effect.all(
          [
            readAll(
              handle.stdout.pipe(Stream.mapError(failed(null))),
              limit,
              tooLarge,
            ),
            readAll(
              handle.stderr.pipe(Stream.mapError(failed(null))),
              DEFAULT_MAX_OUTPUT,
            ),
          ],
          { concurrency: 2 },
        );
        const code = yield* handle.exitCode.pipe(Effect.mapError(failed(null)));
        if (code !== 0 && !(options.okExitCodes ?? []).includes(code)) {
          return yield* failed(code)(
            new Error(stderr.trim() || `git ${subcommand} exited with ${code}`),
          );
        }
        return stdout;
      }),
    ).pipe(UNSLOTTED_SUBCOMMANDS.has(subcommand) ? identity : slots.withPermit);
  });

  // Exit 0 or not, for the checks git answers with its exit code.
  const succeeds = (cwd: string, args: readonly string[]) =>
    run(cwd, args).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // One git per chunk of paths, in order, since index writes take
  // index.lock. Every path came out of git and is a filename, never a
  // pattern: without --literal-pathspecs `a[1].txt` is a glob.
  const runChunked = (
    worktree: string,
    args: readonly string[],
    paths: readonly string[],
    options?: RunOptions,
  ) =>
    Effect.forEach(Arr.chunksOf(paths, PATHSPEC_CHUNK), (chunk) =>
      run(worktree, ["--literal-pathspecs", ...args, "--", ...chunk], options),
    );

  // Writes to one worktree's index run one after another: git takes
  // index.lock for each, so two quick discards, or a discard racing a
  // reset, would otherwise fail on the lock instead of waiting.
  const indexLocks = new Map<string, Semaphore.Semaphore>();
  const onIndex = <A, E>(worktree: string, task: Effect.Effect<A, E>) => {
    let lock = indexLocks.get(worktree);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      indexLocks.set(worktree, lock);
    }
    return lock.withPermit(task);
  };

  return { run, succeeds, runChunked, onIndex };
});

export type RunningArea = Effect.Success<typeof makeRunning>;
