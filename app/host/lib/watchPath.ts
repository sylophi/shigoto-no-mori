// A file watch that can't stop the host. `fs.watch` opens the path it
// watches with a plain open(2) on the calling thread (libuv's
// uv_fs_event_start), so a path whose open does not return stops the
// host's whole loop with it: no call answered, no link, and a host
// restarted onto the same path stuck again as it starts (V3.md, "A
// watch that froze the host"). The one seen: a worktree on an external
// disk, whose first read macOS holds for the Files and Folders prompt
// until someone answers it. A FIFO does the same. So the path is opened
// first on the thread pool, without blocking and within a deadline, and
// watched only once that open came back on a folder or a file. One that
// did not is tried again on an interval, and watched once it opens, so
// the watch is late rather than lost. A held open keeps one pool thread
// until it returns, and a retry waits on it rather than taking another.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { log } from "@shared/log";

const OPEN_WITHIN: Duration.Input = "5 seconds";
const RETRY_EVERY: Duration.Input = "30 seconds";

// An open still on its way, per path.
const opening = new Map<string, Promise<string | null>>();

const opened = (path: string): Promise<string | null> => {
  const held = opening.get(path);
  if (held !== undefined) return held;
  const attempt = open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    .then(async (handle) => {
      try {
        const stat = await handle.stat();
        return stat.isDirectory() || stat.isFile()
          ? null
          : "is not a folder or a file";
      } finally {
        await handle.close().catch(() => {});
      }
    })
    // A path that fails to open fails the watch the same way, without
    // hanging: the watch says so as it always has.
    .catch(() => null)
    .finally(() => opening.delete(path));
  opening.set(path, attempt);
  return attempt;
};

// An open of `path` that did not come back within `within`, in words.
// Off the startup disk, that is macOS holding it for the Files and
// Folders prompt.
export const heldOpen = (path: string, within: Duration.Input): string =>
  path.startsWith("/Volumes/")
    ? "is waiting for permission to read files on a removable or network volume (System Settings, Privacy & Security, Files and Folders)"
    : `did not open within ${Duration.format(Duration.fromInputUnsafe(within))}`;

// Why `path` can't be watched right now, or none when its open came
// back in time on a folder or a file.
export const unwatchable = (
  path: string,
  within: Duration.Input = OPEN_WITHIN,
): Effect.Effect<Option.Option<string>> =>
  Effect.promise(() => opened(path)).pipe(
    Effect.timeoutOption(within),
    Effect.map((result) =>
      Option.isNone(result)
        ? Option.some(heldOpen(path, within))
        : Option.fromNullishOr(result.value),
    ),
  );

// `fs.watch(path, options)`, started once the path opens promptly. Says
// once in the log why a path waits, and again once it is watched.
export const watchPath = (
  fs: FileSystem.FileSystem,
  path: string,
  options?: FileSystem.WatchOptions,
  timing: {
    readonly within?: Duration.Input;
    readonly retryEvery?: Duration.Input;
  } = {},
): Stream.Stream<FileSystem.WatchEvent, PlatformError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      let waited = false;
      while (true) {
        const reason = yield* unwatchable(path, timing.within);
        if (Option.isNone(reason)) break;
        if (!waited) {
          log.warn(
            `[watch] ${path} ${reason.value}: not watched for now, trying again every ${Duration.format(Duration.fromInputUnsafe(timing.retryEvery ?? RETRY_EVERY))}`,
          );
          waited = true;
        }
        yield* Effect.sleep(timing.retryEvery ?? RETRY_EVERY);
      }
      if (waited) log.info(`[watch] ${path} opens again: watched`);
      return fs.watch(path, options);
    }),
  );
