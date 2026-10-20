// Git's runner: a git process in a worktree, its spawn slots, and one index write at a time per worktree.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import {
  captureToFiles,
  readAll,
  readAllBytes,
  readToExit,
} from "../processes.ts";

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
// The commands git runs the person's hooks for, whose output goes to
// files (captureToFiles): a hook gets git's stderr, and pre-push its
// stdout too, and what it leaves in the background is the person's.
const RUNS_HOOKS = new Set([
  "am",
  "checkout",
  "cherry-pick",
  "clone",
  "commit",
  "merge",
  "pull",
  "push",
  "rebase",
  "revert",
  "switch",
  "worktree add",
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
// again: the lock is held for moments, by another program's git (a
// person's `git status` writing back the index it refreshed). A
// command of several steps (a stash, a merge, a rebase, a pull) can be
// refused after its first, and isn't: a stash finishes its own
// (git/stash.ts).
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

// What a read leaves the index as: a `git status` refreshes the index's
// stat cache and writes it back under index.lock when it can, which
// refuses the person's own `git commit` or `rebase` in a terminal at
// that moment (a probe on this repository: 68 of 400 writes refused
// beside a listing every 0.3 s, none with this). A status is always a
// read. Porcelain `git diff` writes it back too and ignores this, so
// the reads of the working tree are plumbing (`diff-index`,
// `diff-files`), which never write it.
const OPTIONAL_LOCKS_OFF = { GIT_OPTIONAL_LOCKS: "0" };

// git's own refusal, its first line, "fatal:" or (a stash's first
// step) "error:". A post-checkout hook that prints the same comes after
// the switch's "Switched to branch"; a pre-commit hook's run again with
// its commit, which nothing recorded yet.
export const indexHeld = (error: unknown): boolean => {
  if (!(error instanceof GitCommandError) || error.exitCode === null) {
    return false;
  }
  const first = stderrOf(error).split("\n", 1)[0] ?? "";
  return (
    /^(fatal|error): Unable to create '/.test(first) &&
    first.endsWith("index.lock': File exists.")
  );
};
export const waitingForIndex = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.retry(effect, {
    schedule: Schedule.exponential("50 millis"),
    times: 5,
    while: indexHeld,
  });

export const makeRunning = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
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
          const gitArgs = NETWORK_SUBCOMMANDS.has(subcommand)
            ? [...STALL_LIMIT, ...args]
            : [...args];
          // LC_ALL=C pins git's messages to English, so what the engine
          // matches on and relays reads the same everywhere.
          const env = {
            ...options.env,
            LC_ALL: "C",
            ...(subcommand === "status" ? OPTIONAL_LOCKS_OFF : {}),
          };
          const stdin =
            options.stdin === undefined
              ? undefined
              : Stream.make(encoder.encode(options.stdin));
          // In a process group of its own (the spawner's default), so
          // closing the scope ends git with its hooks and its ssh. That
          // also leaves it no terminal to prompt on: a credential or
          // host-key question fails instead of waiting.
          const ran = RUNS_HOOKS.has(slotKey)
            ? captureToFiles(spawner, "git", gitArgs, { cwd, env, stdin }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.flatMap(({ stdout, stderr, code }) =>
                  Effect.map(
                    read(Stream.make(stdout), limit, tooLarge),
                    (out) => ({
                      read: [
                        out,
                        decoder.decode(stderr.subarray(0, DEFAULT_MAX_OUTPUT)),
                      ] as const,
                      code,
                    }),
                  ),
                ),
              )
            : Effect.gen(function* () {
                const handle = yield* spawner.spawn(
                  ChildProcess.make("git", gitArgs, {
                    cwd,
                    env,
                    extendEnv: true,
                    stdin: stdin ?? "ignore",
                  }),
                );
                // Its exit ends its process group: what a child of it
                // leaves running would hold its pipes open.
                return yield* readToExit(
                  handle,
                  Effect.all(
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
                  ),
                );
              });
          const {
            read: [stdout, stderr],
            code,
          } = yield* ran.pipe(
            Effect.catchTag("PlatformError", (cause) =>
              Effect.fail(failed(null)(cause)),
            ),
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
      return yield* WAITS_FOR_INDEX.has(subcommand) && options.once !== true
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

  // A status leaves the index's stat cache as it found it (see
  // OPTIONAL_LOCKS_OFF), and a few writes check files by that cache
  // alone: `read-tree -m -u`, `reset --keep` and `--merge`, and the
  // aborts built on them. Refreshed before them, so a file saved with
  // its content unchanged isn't read as in the way.
  const refreshIndex = (worktree: string) =>
    runLenient(worktree, ["update-index", "-q", "--refresh"]);

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
    refreshIndex,
    succeeds,
    runChunked,
    onIndex,
    gitPath,
  };
});

export type RunningArea = Effect.Success<typeof makeRunning>;
