// The update stager's pidfile (updates/staging.pid in the data dir):
// one stager at a time, across the terminal and the app's periodic
// check. A pidfile rather than a lock with a timeout, since staging
// holds it for a whole download, and a crashed holder is told by its
// pid being dead. The Go sm takes the same file the same way.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { atoi } from "./doctorParse.ts";

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

// Who holds the pidfile: none when there is none, and pid 0 when its
// content isn't one.
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
  return Option.some({ pid, alive: yield* pidAlive(pid) });
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
      const taken = yield* fs
        .writeFileString(file, `${process.pid}\n`, { flag: "wx", mode: 0o644 })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
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
