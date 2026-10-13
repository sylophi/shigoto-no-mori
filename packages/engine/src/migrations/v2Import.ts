import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The files the start that imported a 2.x data dir verified, by path to
// their content's hash, and so deleted (Store.ts). A doubt keeps them and
// writes no row. The doctor offers to delete only a leftover whose hash
// is the one verified (a deletion that failed), never one a v2 build
// wrote since.
export const v2Import = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE v2_import (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    files TEXT NOT NULL
  ) STRICT`;
});
