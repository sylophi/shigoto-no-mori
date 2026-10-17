// Git's runner: a git process in a worktree, its spawn slots, and one index write at a time per worktree.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  SLOTTED_SUBCOMMANDS,
  SPAWN_SLOTS,
  encoder,
  decoder,
  identity,
  stderrOf,
} from "./documents.ts";
import { readAll, readAllBytes } from "../processes.ts";

// A transfer that stalls (a connection left half open by a sleep or a
// network that changed) ends rather than waiting for good: http's own
// floor, under 1 KB/s for a minute. ssh's keepalive is the user's own
// config to set, which an override here would take from them.
const NETWORK_SUBCOMMANDS = new Set([
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "clone",
]);
// A fetch that hasn't finished in five minutes is stuck (a remote that
// stopped answering mid-transfer over ssh, which the stall limit can't
// see): it ends, with its git, rather than holding its caller for good.
const FETCH_DEADLINE = "5 minutes";
const STALL_LIMIT = [
  "-c",
  "http.lowSpeedLimit=1000",
  "-c",
  "http.lowSpeedTime=60",
];

// The writes that take index.lock before they change anything, so one
// refused because another git holds it changed nothing and is asked
// again: the lock is held for moments, by a `git diff` that writes back
// the index it refreshed (the app's own views read with one) or another
// program's git. A command of several steps (a stash, a merge, a
// rebase, a pull) can be refused after its first, and isn't.
const WAITS_FOR_INDEX = new Set([
  "add",
  "apply",
  "checkout",
  "commit",
  "mv",
  "read-tree",
  "reset",
  "restore",
  "rm",
  "switch",
  "update-index",
]);
type RunError = GitCommandError | GitOutputTooLargeError;
const indexHeld = (error: RunError): boolean =>
  error instanceof GitCommandError &&
  error.exitCode !== null &&
  stderrOf(error).includes("index.lock': File exists");
const waitingForIndex = <A, R>(effect: Effect.Effect<A, RunError, R>) =>
  Effect.retry(effect, {
    schedule: Schedule.exponential("50 millis"),
    times: 5,
    while: indexHeld,
  });

export const makeRunning = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const slots = yield* Semaphore.make(SPAWN_SLOTS);

  // A git in `cwd`, its stdout taken whole by `read`.
  const runner = <A>(
    span: string,
    read: (
      stdout: Stream.Stream<Uint8Array, GitCommandError>,
      limit: number,
      tooLarge: () => GitOutputTooLargeError,
    ) => Effect.Effect<A, GitCommandError | GitOutputTooLargeError>,
  ) =>
    Effect.fn(span)(function* (
      cwd: string,
      args: readonly string[],
      options: RunOptions = {},
    ) {
      const subcommand = subcommandOf(args);
      // `worktree`'s own subcommand decides, as `worktree list`.
      const slotKey =
        subcommand === "worktree"
          ? `worktree ${args[args.indexOf(subcommand) + 1] ?? ""}`
          : subcommand;
      yield* Effect.annotateCurrentSpan({ subcommand, cwd });
      const failed = (exitCode: number | null) => (cause: unknown) =>
        new GitCommandError({ subcommand, exitCode, cause });
      const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
      const tooLarge = () =>
        new GitOutputTooLargeError({ subcommand, limitBytes: limit });
      const once = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(
                "git",
                NETWORK_SUBCOMMANDS.has(subcommand)
                  ? [...STALL_LIMIT, ...args]
                  : [...args],
                {
                  cwd,
                  // LC_ALL=C pins git's messages to English, so what the
                  // engine matches on and relays reads the same everywhere.
                  // GIT_OPTIONAL_LOCKS=0 keeps `git status` from taking
                  // index.lock to write back the index it refreshed.
                  env: { ...options.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
                  extendEnv: true,
                  // In a process group of its own (the spawner's default), so
                  // closing the scope ends git with its hooks and its ssh.
                  // That also leaves it no terminal to prompt on: a
                  // credential or host-key question fails instead of waiting.
                  stdin:
                    options.stdin === undefined
                      ? "ignore"
                      : Stream.make(encoder.encode(options.stdin)),
                },
              ),
            )
            .pipe(Effect.mapError(failed(null)));
          const [stdout, stderr] = yield* Effect.all(
            [
              read(
                handle.stdout.pipe(Stream.mapError(failed(null))),
                limit,
                tooLarge,
              ),
              readAll(
                handle.stderr.pipe(Stream.mapError(failed(null))),
                DEFAULT_MAX_OUTPUT,
                { decoder },
              ),
            ],
            { concurrency: 2 },
          );
          const code = yield* handle.exitCode.pipe(
            Effect.mapError(failed(null)),
          );
          if (
            code !== 0 &&
            options.anyExit !== true &&
            !(options.okExitCodes ?? []).includes(code)
          ) {
            return yield* failed(code)(
              new Error(
                stderr.trim() || `git ${subcommand} exited with ${code}`,
              ),
            );
          }
          return stdout;
        }),
      ).pipe(
        subcommand === "fetch" && options.local !== true
          ? Effect.timeoutOrElse({
              duration: FETCH_DEADLINE,
              orElse: () =>
                Effect.fail(
                  failed(null)(
                    new Error("git fetch didn't finish within 5 minutes"),
                  ),
                ),
            })
          : identity,
        SLOTTED_SUBCOMMANDS.has(slotKey) ? slots.withPermit : identity,
      );
      return yield* WAITS_FOR_INDEX.has(subcommand)
        ? waitingForIndex(once)
        : once;
    });

  const run = runner("Git.run", (stdout, limit, tooLarge) =>
    readAll(stdout, limit, { tooLarge, decoder }),
  );
  // `run` for output that isn't text: a blob's contents.
  const runBytes = runner("Git.runBytes", readAllBytes);

  // What git printed, whatever its exit, for a read that has an answer
  // either way (a merge-tree that exits 1 on a conflict, a log of a ref
  // that may not resolve). A git that never ran answers empty, and
  // output past the cap still fails: a prefix isn't the answer.
  const runLenient = (
    cwd: string,
    args: readonly string[],
    options: RunOptions = {},
  ) =>
    run(cwd, args, { ...options, anyExit: true }).pipe(
      Effect.catchTags({ GitCommandError: () => Effect.succeed("") }),
    );

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
  const onIndex = <A, E, R>(worktree: string, task: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      let lock = indexLocks.get(worktree);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        indexLocks.set(worktree, lock);
      }
      return lock.withPermit(task);
    });

  // A file of the repository's git dir (`index`, `info/exclude`, a
  // hook), as an absolute path: a linked worktree's own, or the common
  // dir's, as git resolves it.
  const gitPath = (cwd: string, name: string) =>
    Effect.map(
      run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name]),
      (out) => out.trim(),
    );

  return {
    run,
    runBytes,
    runLenient,
    succeeds,
    runChunked,
    onIndex,
    gitPath,
  };
});

export type RunningArea = Effect.Success<typeof makeRunning>;
