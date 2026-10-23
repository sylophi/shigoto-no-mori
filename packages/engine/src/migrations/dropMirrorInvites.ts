import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The mirror_invites table an earlier step made, which nothing reads.
export const dropMirrorInvites = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS mirror_invites`;
});
