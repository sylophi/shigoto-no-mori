// What clones proved about a source's files: the clone_verified table, read, kept and forgotten.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { worktreeIdFromPath } from "../worktreeLayout.ts";
import { RECORDS_PER_STATEMENT } from "./documents.ts";

export const makeVerified = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordsOf = (source: string) =>
    sql<{ path: string; record: string }>`
      SELECT path, record FROM clone_verified
      WHERE source_id = ${worktreeIdFromPath(source)}`.pipe(
      Effect.map(
        (rows) => new Map(rows.map(({ path: p, record }) => [p, record])),
      ),
      Effect.orElseSucceed(() => new Map<string, string>()),
    );

  // Adds the newly proven records, dropping any whose path no longer has
  // that blob and stat in the source's index (`current`). Best effort:
  // without them the next clone reads those files again.
  const keepRecords = (
    source: string,
    added: ReadonlyMap<string, string>,
    current: (file: string, record: string) => boolean,
  ) => {
    const sourceId = worktreeIdFromPath(source);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const stale = [...(yield* recordsOf(source))]
            .filter(([file, record]) => !current(file, record))
            .map(([file]) => file);
          // In chunks, under SQLite's limit on a statement's parameters.
          for (const chunk of Arr.chunksOf(stale, RECORDS_PER_STATEMENT)) {
            yield* sql`DELETE FROM clone_verified WHERE source_id = ${sourceId}
              AND ${sql.in("path", chunk)}`;
          }
          for (const chunk of Arr.chunksOf([...added], RECORDS_PER_STATEMENT)) {
            yield* sql`INSERT INTO clone_verified ${sql.insert(
              chunk.map(([file, record]) => ({
                source_id: sourceId,
                path: file,
                record,
              })),
            )} ON CONFLICT (source_id, path) DO UPDATE SET record = excluded.record`;
          }
        }),
      )
      .pipe(Effect.ignore);
  };

  const forget = Effect.fn("CloneCheckout.forget")(function* (
    worktreeId: string,
  ) {
    yield* sql`DELETE FROM clone_verified WHERE source_id = ${worktreeId}`;
  }, Effect.orDie);

  return { recordsOf, keepRecords, forget };
});

export type VerifiedArea = Effect.Success<typeof makeVerified>;
