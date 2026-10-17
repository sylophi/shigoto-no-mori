// What makes a data-folder move the one change under way (V3.md, Commit
// points): a database of its own beside the pointer file, where every
// process of the flavor finds it wherever the data dir is. A change that
// writes holds it shared for its run (`guard`), at the engine's entry
// points; a move, and the recovery of one, holds it alone. SQLite's
// locks are the kernel's, so a hold goes with its process, however that
// ends, and nothing reads a pid to tell.
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
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Paths from "./Paths.ts";
import type { OpenDatabase } from "./Store.ts";

const LOCK = "data-dir.lock";

// A change refused while a move, or the recovery of one, is under way.
export class DataDirMoving extends Schema.TaggedError<DataDirMoving>()(
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

// A move refused because the lock can't be made.
export class DataDirLockUnavailable extends Schema.TaggedError<DataDirLockUnavailable>()(
  "DataDirLockUnavailable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `The data folder can't be moved: its lock at ${this.file} can't be made (${this.reason}).`;
  }
}

// Whether the running change already holds the lock, so a change
// nested in it joins even while a move of this process's waits.
const Holding = Context.Reference<boolean>("sm/engine/DataDirLock/Holding", {
  defaultValue: () => false,
});

export class DataDirLock extends Context.Service<
  DataDirLock,
  {
    // The hold `guard` takes, kept until the scope it is taken in closes.
    readonly held: Effect.Effect<
      void,
      DataDirMoving | DataDirMoved,
      Scope.Scope
    >;
    // `effect` run while no move can start, in a process whose data dir
    // is still where it is found.
    readonly guard: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | DataDirMoving | DataDirMoved, R>;
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
      const file = path.join(dir, LOCK);
      // A connection in exclusive locking mode keeps the lock its first
      // read (shared) or write (its own) takes until it closes, with the
      // scope it was opened in. A lock held elsewhere is asked for again
      // every 50 ms up to `within`, not waited for in SQLite, whose wait
      // under node:sqlite stops the whole process, so a change of this
      // process's own could never end while its move waits.
      const hold = (within: Duration.Input, write: boolean) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dir, { recursive: true });
          const sql = yield* open(file, { disableWAL: true, busyTimeout: 0 });
          yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
          const take = write
            ? Effect.andThen(
                sql`CREATE TABLE IF NOT EXISTS held (id INTEGER PRIMARY KEY)`,
                sql`INSERT OR REPLACE INTO held (id) VALUES (1)`,
              )
            : sql`SELECT count(*) FROM sqlite_schema`;
          yield* take.pipe(
            Effect.retry({
              while: (error) =>
                Predicate.isTagged(error.reason, "LockTimeoutError"),
              schedule: Schedule.spaced("50 millis"),
              times: Math.ceil(
                Duration.toMillis(Duration.fromInputUnsafe(within)) / 50,
              ),
            }),
          );
        }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));

      const takeShared = Effect.gen(function* () {
        const taken = yield* hold(Duration.seconds(2), false).pipe(
          Effect.as("held" as const),
          Effect.catchReason("SqlError", "LockTimeoutError", () =>
            Effect.succeed("busy" as const),
          ),
          // A lock that can't be made at all, in a folder this user
          // can't write, makes every move refuse too, so the change
          // runs.
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning(
                `[data] the data-folder lock at ${file} can't be held`,
                error,
              ),
              "unavailable" as const,
            ),
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
      const held = Effect.acquireRelease(
        Effect.suspend(() => {
          const queuedFor = taking ? takes : takes + 1;
          return joining.withPermits(1)(
            Effect.gen(function* () {
              const nested = yield* Holding;
              if (moving > 0 && !nested) return yield* new DataDirMoving();
              if (holders === 0) {
                if (refused >= queuedFor) return yield* new DataDirMoving();
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
            hold(within, true).pipe(
              Effect.catchReason("SqlError", "LockTimeoutError", () =>
                Effect.fail(new ChangesRunning()),
              ),
              Effect.catchTag(
                "SqlError",
                (error) =>
                  new DataDirLockUnavailable({ file, reason: error.message }),
              ),
              Effect.catchTag(
                "PlatformError",
                (error) =>
                  new DataDirLockUnavailable({ file, reason: error.message }),
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
