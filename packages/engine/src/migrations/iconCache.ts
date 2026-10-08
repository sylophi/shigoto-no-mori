import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Each project's icon as last found, by the project's path, so a
// listing pays the repo scan once. An entry with no source path
// remembers that the project has none.
export const iconCache = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE icon_cache (
    project_path TEXT PRIMARY KEY,
    source_path TEXT,
    size INTEGER,
    mtime_ms REAL,
    updated_at INTEGER NOT NULL
  ) STRICT`;
});
