// What makes a data-folder move the one change under way: a database of
// its own beside the pointer file, where every process of the flavor
// finds it wherever the data dir is.
// A change that writes holds it shared for its run (`guard`), at the
// engine's entry points; a move, and the recovery of one, holds it
// alone. SQLite's locks are the kernel's, so a hold goes with its
// process, however that ends, and nothing reads a pid to tell.
//
// The entry points: every call that changes code (what a peer needs the
// `changeCode` grant for), a landing's create, capture and apply as one
// change wherever it is asked from, every change the host makes through
// the engine (`asChange`), the auto-pull's fast-forward, and each
// terminal command that changes a worktree on disk (`changing`, and
// `changingWithFix` for the doctor's `--fix`). A write that only touches
// the store holds nothing: from before the journal's first write until
// after it is gone, the store refuses every write but the move's
// (`dataDirMoveJournal.ts`).
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { DATA_DIR_LOCK } from "./footprint.ts";
import * as Paths from "./Paths.ts";
import type { OpenDatabase } from "./Store.ts";

// A lock held elsewhere asked for again every 50 ms up to `within`.
const askedFor = (within: Duration.Input) => ({
  while: (error: unknown) =>
    error instanceof SqlError.SqlError &&
    Predicate.isTagged(error.reason, "LockTimeoutError"),
  schedule: Schedule.spaced("50 millis"),
  times: Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(within)) / 50),
});

// What SQLite said under a failure: node's driver carries `errcode`
// and `errstr`, Bun's `code` and its message. Broken is a file that
// isn't a database, or one SQLite reads as corrupt.
const nativeOf = (error: unknown) => {
  const cause =
    error instanceof SqlError.SqlError &&
    Predicate.hasProperty(error.reason, "cause")
      ? error.reason.cause
      : error;
  const errcode =
    Predicate.hasProperty(cause, "errcode") && typeof cause.errcode === "number"
      ? cause.errcode & 0xff
      : undefined;
  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
  return {
    broken:
      errcode === 26 ||
      errcode === 11 ||
      code === "SQLITE_NOTADB" ||
      code === "SQLITE_CORRUPT",
    words:
      Predicate.hasProperty(cause, "errstr") && typeof cause.errstr === "string"
        ? cause.errstr
        : cause instanceof Error
          ? cause.message
          : String(error),
  };
};

// A change refused while a move, or the recovery of one, is under way.
class DataDirMoving extends Schema.TaggedError<DataDirMoving>()(
  "DataDirMoving",
  {},
) {
  override get message(): string {
    return "The data folder is being moved. Try again once that's done.";
  }
}

// A change refused in a process that found the data dir before a move
// took it elsewhere.
export class DataDirMoved extends Schema.TaggedError<DataDirMoved>()(
  "DataDirMoved",
  { to: Schema.String },
) {
  override get message(): string {
    return `The data folder moved to ${this.to}. Run it again.`;
  }
}

// A move refused while a change it would wait for still runs.
export class ChangesRunning extends Schema.TaggedError<ChangesRunning>()(
  "ChangesRunning",
  {},
) {
  override get message(): string {
    return "Another change to the worktrees is still running (in the app or a terminal). Try again when it finishes.";
  }
}

// A change or a move refused because the lock can't be held.
export class DataDirLockUnavailable extends Schema.TaggedError<DataDirLockUnavailable>()(
  "DataDirLockUnavailable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `The data folder's lock at ${this.file} can't be held (${this.reason}).`;
  }
}

// What refuses a change the hold.
export type TakeRefused = DataDirMoving | DataDirMoved | DataDirLockUnavailable;

// Whether the running change already holds the lock, so a change
// nested in it joins even while a move of this process's waits.
const Holding = Context.Reference<boolean>("sm/engine/DataDirLock/Holding", {
  defaultValue: () => false,
});

export class DataDirLock extends Context.Service<
  DataDirLock,
  {
    // The hold `guard` takes, kept until the scope it is taken in closes.
    readonly held: Effect.Effect<void, TakeRefused, Scope.Scope>;
    // `effect` run while no move can start, in a process whose data dir
    // is still where it is found.
    readonly guard: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | TakeRefused, R>;
    // `effect` run as the one change under way, once those under way
    // have ended, waiting for them up to `within`.
    readonly alone: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      within: Duration.Input,
    ) => Effect.Effect<A, E | ChangesRunning | DataDirLockUnavailable, R>;
  }
>()("sm/engine/DataDirLock") {}

export const layer = (open: OpenDatabase) =>
  Layer.effect(
    DataDirLock,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const paths = yield* Paths.Paths;
      const reactivity = yield* Reactivity.Reactivity;
      const dir = path.dirname(paths.pointerFile);
      const file = path.join(dir, DATA_DIR_LOCK);
      // A connection in exclusive locking mode keeps the lock its first
      // read (shared) or write (its own) takes until it closes, with the
      // scope it was opened in. A lock held elsewhere is asked for again
      // every 50 ms up to `within`, not waited for in SQLite, whose wait
      // under node:sqlite stops the whole process, so a change of this
      // process's own could never end while its move waits.
      const connect = Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true });
        const sql = yield* open(file, { disableWAL: true, busyTimeout: 0 });
        yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
        return sql;
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));

      // Shared: a read, which a move holding the lock refuses with
      // nothing held.
      const holdShared = Effect.gen(function* () {
        const sql = yield* connect;
        yield* sql`SELECT count(*) FROM sqlite_schema`.pipe(
          Effect.retry(askedFor(Duration.seconds(2))),
        );
      });

      // Alone: the write reserved first, an attempt refused it dropping
      // its connection, so two takers never hold each other off with the
      // reads their attempts took; the one reserved waits at its commit
      // for the reads under way, and refuses new ones meanwhile.
      const holdAlone = (within: Duration.Input) =>
        Effect.gen(function* () {
          const outer = yield* Effect.scope;
          // One wait for both steps.
          const until =
            (yield* Clock.currentTimeMillis) +
            Duration.toMillis(Duration.fromInputUnsafe(within));
          const reserve = Effect.gen(function* () {
            // A child of the hold's scope, so an interrupt at any point
            // still closes its connection with the hold.
            const scope = yield* Scope.fork(outer);
            const exit = yield* Effect.exit(
              Scope.provide(
                Effect.tap(connect, (sql) => sql`BEGIN IMMEDIATE`),
                scope,
              ),
            );
            if (Exit.isFailure(exit)) {
              yield* Scope.close(scope, exit);
              return yield* exit;
            }
            return exit.value;
          });
          const sql = yield* reserve.pipe(Effect.retry(askedFor(within)));
          yield* sql`CREATE TABLE IF NOT EXISTS held (id INTEGER PRIMARY KEY)`;
          yield* sql`INSERT OR REPLACE INTO held (id) VALUES (1)`;
          const left = Math.max(0, until - (yield* Clock.currentTimeMillis));
          yield* sql`COMMIT`.pipe(
            Effect.retry(askedFor(Duration.millis(left))),
          );
        });

      // Whether this user can write the lock, or the folder it goes in.
      const lockWritable = Effect.gen(function* () {
        const there = (at: string) =>
          fs.exists(at).pipe(Effect.orElseSucceed(() => false));
        const at = (yield* there(file))
          ? file
          : (yield* there(dir))
            ? dir
            : path.dirname(dir);
        return yield* fs.access(at, { writable: true }).pipe(Effect.isSuccess);
      });

      const takeShared = Effect.gen(function* () {
        const taken = yield* holdShared.pipe(
          Effect.as("held" as const),
          Effect.catchReason("SqlError", "LockTimeoutError", () =>
            Effect.succeed("busy" as const),
          ),
          Effect.catch((error) =>
            Effect.gen(function* () {
              // A lock this user can't write, or one that isn't a lock
              // database at all, makes every move refuse too, so the
              // change runs. Any other failure is this process's alone,
              // and a move elsewhere may hold the lock.
              const native = nativeOf(error);
              if (!native.broken && (yield* lockWritable)) {
                return yield* new DataDirLockUnavailable({
                  file,
                  reason: native.words,
                });
              }
              yield* Effect.logWarning(
                `[data] the data-folder lock at ${file} can't be held`,
                error,
              );
              return "unavailable" as const;
            }),
          ),
        );
        if (taken === "busy") return yield* new DataDirMoving();
        const now = yield* paths.current;
        if (
          path.resolve(now) !== path.resolve(paths.dataDir) ||
          !(yield* fs
            .exists(paths.dataDir)
            .pipe(Effect.orElseSucceed(() => true)))
        ) {
          return yield* new DataDirMoved({ to: now });
        }
      });

      // The process's one shared hold: taken and checked by the first
      // change, joined by the others in the order they came, let go by
      // the last to end. No move can commit while it is held, so the
      // check stays true. A move of this process's own, waiting for the
      // changes under way, refuses new ones, which would otherwise keep
      // joining, but not one nested in a change already holding it,
      // which would leave that change half done. A take refused by a move
      // refuses the changes that queued while it was asked for or after,
      // rather than each ask again in turn.
      const joining = yield* Semaphore.make(1);
      let holders = 0;
      let opened: Scope.Closeable | undefined;
      let moving = 0;
      // Takes are numbered as they start; the first a change queued for
      // is the one under way as it came, else the next.
      let takes = 0;
      let taking = false;
      let refused = 0;
      let refusal: Exit.Exit<void, TakeRefused> = Exit.void;
      const held = Effect.acquireRelease(
        Effect.suspend(() => {
          const queuedFor = taking ? takes : takes + 1;
          return joining.withPermits(1)(
            Effect.gen(function* () {
              const nested = yield* Holding;
              if (moving > 0 && !nested) return yield* new DataDirMoving();
              if (holders === 0) {
                if (refused >= queuedFor) return yield* refusal;
                takes += 1;
                taking = true;
                const scope = yield* Scope.make();
                const exit = yield* Effect.exit(
                  Scope.provide(takeShared, scope),
                );
                taking = false;
                if (Exit.isFailure(exit)) {
                  yield* Scope.close(scope, exit);
                  refused = takes;
                  refusal = exit;
                  return yield* exit;
                }
                opened = scope;
              }
              holders += 1;
            }),
          );
        }),
        () =>
          joining.withPermits(1)(
            Effect.gen(function* () {
              holders -= 1;
              if (holders > 0 || opened === undefined) return;
              const scope = opened;
              opened = undefined;
              yield* Scope.close(scope, Exit.void);
            }),
          ),
      );

      const guard = Effect.fn("DataDirLock.guard")(function* <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ) {
        return yield* Effect.scoped(
          Effect.andThen(held, Effect.provideService(effect, Holding, true)),
        );
      });

      const alone = Effect.fn("DataDirLock.alone")(function* <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        within: Duration.Input,
      ) {
        moving += 1;
        return yield* Effect.scoped(
          Effect.andThen(
            holdAlone(within).pipe(
              Effect.catchReason("SqlError", "LockTimeoutError", () =>
                Effect.fail(new ChangesRunning()),
              ),
              Effect.catchTag(
                "SqlError",
                (error) =>
                  new DataDirLockUnavailable({
                    file,
                    reason: nativeOf(error).words,
                  }),
              ),
              Effect.catchTag(
                "PlatformError",
                (error) =>
                  new DataDirLockUnavailable({
                    file,
                    reason: nativeOf(error).words,
                  }),
              ),
            ),
            effect,
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              moving -= 1;
            }),
          ),
        );
      });

      return DataDirLock.of({ held, guard, alone });
    }),
  ).pipe(Layer.provide(Reactivity.layer));
