// This device's copy of the shared settings
// (@shigomori/contracts/schemas/sharedSettings), one row per entry. The
// rule a copy keeps (a write or a merge that changes nothing stores
// nothing) is the caller's: this is its storage, read whole and updated
// whole inside one transaction, so two writers never overwrite each
// other's entries.
import {
  type SharedSettingsDoc,
  SharedSettingsDocSchema,
} from "@shigomori/contracts/schemas/sharedSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { parseJson } from "./json.ts";

export class SharedSettings extends Context.Service<
  SharedSettings,
  {
    // The entries this build can read. One it can't (a newer build's
    // longer value, a mangled stamp) is left out and keeps its row.
    readonly read: Effect.Effect<SharedSettingsDoc>;
    // Runs `next` on the stored copy and stores its answer: an entry it
    // drops is deleted, a new or replaced one written. `next` handing
    // back the copy it was given stores nothing, which is how a caller
    // tells a no-op from a change. Answers what `next` did.
    readonly update: (
      next: (current: SharedSettingsDoc) => SharedSettingsDoc,
    ) => Effect.Effect<SharedSettingsDoc>;
  }
>()("sm/engine/SharedSettings") {}

const decodeDoc = Schema.decodeUnknownOption(SharedSettingsDocSchema);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // In the order the entries were first written, as registry.json held
  // them.
  const stored = sql<{ key: string; entry: string }>`
    SELECT key, entry FROM shared_settings ORDER BY rowid`.pipe(
    Effect.map((rows) =>
      Option.getOrElse(
        decodeDoc({
          entries: Object.fromEntries(
            rows.flatMap(({ key, entry }) =>
              Option.match(parseJson(entry), {
                onNone: () => [],
                onSome: (value) => [[key, value]],
              }),
            ),
          ),
        }),
        () => ({ entries: {} }),
      ),
    ),
  );

  const read = stored.pipe(
    Effect.orDie,
    Effect.withSpan("SharedSettings.read"),
  );

  const update = Effect.fn("SharedSettings.update")(function* (
    next: (current: SharedSettingsDoc) => SharedSettingsDoc,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* stored;
        const result = next(current);
        if (result === current) return result;
        const held = new Map(Object.entries(current.entries));
        const kept = new Map(Object.entries(result.entries));
        const dropped = [...held.keys()].filter((key) => !kept.has(key));
        const written = [...kept].filter(
          ([key, entry]) => held.get(key) !== entry,
        );
        if (dropped.length > 0) {
          yield* sql`DELETE FROM shared_settings WHERE ${sql.in("key", dropped)}`;
        }
        if (written.length > 0) {
          yield* sql`INSERT INTO shared_settings ${sql.insert(
            written.map(([key, entry]) => ({
              key,
              entry: JSON.stringify(entry),
            })),
          )} ON CONFLICT (key) DO UPDATE SET entry = excluded.entry`;
        }
        return result;
      }),
    );
  }, Effect.orDie);

  return SharedSettings.of({ read, update });
});

export const layer = Layer.effect(SharedSettings, make);
