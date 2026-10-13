import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Whether the start that imported a 2.x data dir verified the import,
// and so deleted its files (Store.ts). A doubt keeps them, and the
// doctor offers to delete only a verified import's leftovers (a v2
// build wrote them again, or a deletion failed).
export const v2Import = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE v2_import (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    verified INTEGER NOT NULL
  ) STRICT`;
});
