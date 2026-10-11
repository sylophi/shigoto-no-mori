import { GitStateCoreSchema } from "@shigomori/contracts/modules/mirror";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { fileSyncDocument } from "./fileSyncFile.ts";

// The git state each mirror session's two sides last agreed on
// (MirrorAgreements.ts), by session id, as the JSON of a GitStateCore.
// A 2.x data dir keeps them in file-sync/git-follow.json, taken from it
// here: an entry that doesn't parse is skipped.
const decodeAgreed = Schema.decodeUnknownOption(GitStateCoreSchema);

export const mirrorAgreements = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mirror_agreements (
    session TEXT PRIMARY KEY,
    state TEXT NOT NULL
  ) STRICT`;
  const doc = yield* fileSyncDocument("git-follow.json");
  const agreed = Option.match(doc, {
    onNone: () => undefined,
    onSome: (fields) => fields["agreed"],
  });
  const rows = Object.entries(
    typeof agreed === "object" && agreed !== null ? agreed : {},
  ).flatMap(([session, state]) =>
    Option.match(decodeAgreed(state), {
      onNone: () => [],
      onSome: (core) => [{ session, state: JSON.stringify(core) }],
    }),
  );
  if (rows.length > 0) {
    yield* sql`INSERT INTO mirror_agreements ${sql.insert(rows)}`;
  }
});
