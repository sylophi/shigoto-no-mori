import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { watchTable } from "./changes.ts";
import { registryHint } from "./importJson.ts";

// When each worktree last came off the shelf (`sm unshelve`, adopt, or
// a listing that saw it worked in), epoch ms. The idle shelf (shelf.ts)
// counts it as a touch, so an unshelved worktree isn't shelved again by
// the next listing. A shelve clears the row. A 2.x registry.json keeps
// the same under `unshelvedAt`, taken from it here as the import took
// its siblings.
export const unshelvedAt = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE unshelved_at (
    worktree_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  ) STRICT`;
  const rows = Object.entries(yield* registryHint("unshelvedAt", {})).map(
    ([worktree_id, at]) => ({ worktree_id, at }),
  );
  if (rows.length > 0) {
    yield* sql`INSERT INTO unshelved_at ${sql.insert(rows)}`;
  }
  yield* watchTable("unshelved_at");
});
