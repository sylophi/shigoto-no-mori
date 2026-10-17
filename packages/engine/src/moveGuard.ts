// A mutation of the worktrees or what is kept under their ids, as a
// data-folder move sees it (V3.md, Commit points): its first write is a
// row of its own in `mutations`, which a move's refusal turns down, so a
// mutation never starts while a move owns the store, and one already
// under way is what the move waits for before it plans.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Option from "effect/Option";
import { thisProcess } from "./dataDirMoveJournal.ts";
import { pidAlive, stillRunning } from "./processes.ts";

export const asMutation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const me = yield* thisProcess;
        const id = `${me.pid}-${(yield* Random.nextInt).toString(36)}`;
        yield* sql`INSERT INTO mutations ${sql.insert({
          id,
          pid: me.pid,
          started_at: me.startedAt,
        })}`;
        return id;
      }).pipe(Effect.orDie),
      () => effect,
      (id) => sql`DELETE FROM mutations WHERE id = ${id}`.pipe(Effect.ignore),
    ),
  );

// A service's method made a mutation, over the store the service holds.
export const guarded =
  (sql: SqlClient.SqlClient) =>
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    method: (...args: Args) => Effect.Effect<A, E, R>,
  ) =>
  (...args: Args) =>
    asMutation(method(...args)).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );

// Whether a mutation's process still runs.
const running = (row: { readonly pid: number; readonly started_at: number }) =>
  Effect.flatMap(
    Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner),
    (spawner) =>
      Option.isSome(spawner)
        ? stillRunning(row.pid, row.started_at).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              spawner.value,
            ),
          )
        : pidAlive(row.pid),
  );

// Every mutation under way when the store began refusing, waited out up
// to `within`: false when one still runs then. A dead process's rows go.
export const awaitMutations = (within: Duration.Input) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const settledNow = Effect.gen(function* () {
      const rows = yield* sql<{
        id: string;
        pid: number;
        started_at: number;
      }>`SELECT id, pid, started_at FROM mutations`;
      let live = 0;
      for (const row of rows) {
        if (yield* running(row)) live += 1;
        else yield* sql`DELETE FROM mutations WHERE id = ${row.id}`;
      }
      return live === 0;
    });
    return yield* settledNow.pipe(
      Effect.repeat({
        until: (done) => done,
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeoutOption(within),
      Effect.map(Option.getOrElse(() => false)),
    );
  });
