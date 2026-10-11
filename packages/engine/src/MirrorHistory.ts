import {
  type MirrorEvent,
  MirrorEventSchema,
} from "@shigomori/contracts/modules/mirror";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const ThreadJson = Schema.fromJsonString(Schema.Array(MirrorEventSchema));
const decodeThread = Schema.decodeUnknownOption(ThreadJson);
const encodeThread = Schema.encodeSync(ThreadJson);

// What happened to each mirror, the thread the mirror page shows, by
// the local worktree it is keyed by, which the host reads at start and
// writes as it changes.
export class MirrorHistory extends Context.Service<
  MirrorHistory,
  {
    // A thread this build can't read is left out.
    readonly load: Effect.Effect<Record<string, ReadonlyArray<MirrorEvent>>>;
    // Replaces every thread with `threads`.
    readonly save: (
      threads: Record<string, ReadonlyArray<MirrorEvent>>,
    ) => Effect.Effect<void>;
  }
>()("sm/engine/MirrorHistory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const load = sql<{
    worktree_id: string;
    events: string;
  }>`SELECT worktree_id, events FROM mirror_history`.pipe(
    Effect.map((rows) =>
      Object.fromEntries(
        rows.flatMap((row) =>
          Option.match(decodeThread(row.events), {
            onNone: () => [],
            onSome: (thread) => [[row.worktree_id, thread] as const],
          }),
        ),
      ),
    ),
    Effect.orDie,
    Effect.withSpan("MirrorHistory.load"),
  );

  const save = Effect.fn("MirrorHistory.save")(function* (
    threads: Record<string, ReadonlyArray<MirrorEvent>>,
  ) {
    const rows = Object.entries(threads).map(([worktree_id, thread]) => ({
      worktree_id,
      events: encodeThread(thread),
    }));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM mirror_history`;
        if (rows.length > 0) {
          yield* sql`INSERT INTO mirror_history ${sql.insert(rows)}`;
        }
      }),
    );
  }, Effect.orDie);

  return MirrorHistory.of({ load, save });
});

export const layer = Layer.effect(MirrorHistory, make);
