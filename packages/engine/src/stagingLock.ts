// The update stager's pidfile (updates/staging.pid in the data dir):
// one stager at a time, across the terminal and the app's periodic
// check. A pidfile rather than a lock with a timeout, since staging
// holds it for a whole download, and a crashed holder is told by its
// pid being dead. A v2 Go sm takes the same file the same way.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { atoi } from "./doctorParse.ts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { captureWithin, pidAlive } from "./processes.ts";

// A stager is downloading an update, and owns the files in updates/.
export class UpdateInProgress extends Schema.TaggedError<UpdateInProgress>()(
  "UpdateInProgress",
  { pid: Schema.Finite },
) {
  override get message(): string {
    return `Another update is already in progress (pid ${this.pid}).`;
  }
}

// The pidfile kept changing hands and couldn't be taken.
export class StagingLockUnavailable extends Schema.TaggedError<StagingLockUnavailable>()(
  "StagingLockUnavailable",
  { path: Schema.String },
) {
  override get message(): string {
    return `Couldn't take the update staging lock at ${this.path}.`;
  }
}

export const stagingLockPath = (path: Path.Path, dataDir: string) =>
  path.join(dataDir, "updates", "staging.pid");

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

// Who holds the pidfile: none when there is none, and pid 0 when its
// content isn't one. A live pid that started after the file was written
// is another process that was handed the number after a crash or a
// reboot: the holder is gone.
export const stagingHolder = Effect.fn("stagingHolder")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(raw)) return Option.none();
  const pid = atoi(raw.value.trim());
  // kill(0) and kill(-1) always "succeed".
  if (pid === undefined || pid < 2)
    return Option.some({ pid: 0, alive: false });
  if (!(yield* pidAlive(pid))) return Option.some({ pid, alive: false });
  const written = yield* fs.stat(file).pipe(
    Effect.map((info) => Option.map(info.mtime, (at) => at.getTime())),
    Effect.orElseSucceed(() => Option.none<number>()),
  );
  const age = yield* ageOf(pid);
  const now = yield* Clock.currentTimeMillis;
  // A few seconds' slack: ps counts in whole seconds.
  const startedAfter =
    Option.isSome(written) &&
    Option.isSome(age) &&
    now - age.value * 1000 > written.value + 5000;
  return Option.some({ pid, alive: !startedAfter });
});

// The pidfile, held by this process until the scope closes. A dead
// holder's file is claimed by renaming it first: the rename succeeds for
// exactly one contender, so two processes breaking the same stale lock
// can't each remove the other's fresh one.
export const acquireStagingLock = Effect.fn("acquireStagingLock")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const take = Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      // Only an existing file is someone else's: a folder that can't be
      // written, or a full disk, says so.
      const taken = yield* fs
        .writeFileString(file, `${process.pid}\n`, { flag: "wx", mode: 0o644 })
        .pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => Predicate.isTagged(error.reason, "AlreadyExists"),
            () => Effect.succeed(false),
          ),
        );
      if (taken) return;
      const holder = yield* stagingHolder(file);
      if (Option.isSome(holder) && holder.value.alive) {
        return yield* new UpdateInProgress({ pid: holder.value.pid });
      }
      const stale = `${file}.stale-${process.pid}`;
      yield* fs
        .rename(file, stale)
        .pipe(Effect.andThen(fs.remove(stale)), Effect.ignore);
    }
    return yield* new StagingLockUnavailable({ path: file });
  });
  yield* Effect.acquireRelease(take, () => fs.remove(file).pipe(Effect.ignore));
});
