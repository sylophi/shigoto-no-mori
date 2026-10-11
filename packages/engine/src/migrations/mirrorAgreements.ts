import { GitStateCoreSchema } from "@shigomori/contracts/modules/mirror";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Paths from "../Paths.ts";
import { isAbsent } from "../platformErrors.ts";

// The git state each mirror session's two sides last agreed on
// (MirrorAgreements.ts), by session id, as the JSON of a GitStateCore.
// A 2.x data dir keeps them in file-sync/git-follow.json, taken from it
// here: an entry that doesn't parse is skipped, and the file stays
// where it is.
const AgreedFile = Schema.fromJsonString(
  Schema.Struct({
    agreed: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
const decodeAgreed = Schema.decodeUnknownOption(GitStateCoreSchema);

export const mirrorAgreements = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { dataDir } = yield* Paths.Paths;
  yield* sql`CREATE TABLE mirror_agreements (
    session TEXT PRIMARY KEY,
    state TEXT NOT NULL
  ) STRICT`;
  const file = path.join(dataDir, "file-sync", "git-follow.json");
  const skipped = Effect.logWarning(
    "Skipped what the store could not import",
  ).pipe(Effect.annotateLogs({ path: file, what: "the file" }));
  const text = yield* fs.readFileString(file).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isAbsent, () => Effect.succeed(Option.none<string>())),
    Effect.catchTags({
      PlatformError: () => Effect.as(skipped, Option.none<string>()),
    }),
  );
  const agreed = Option.flatMap(text, Schema.decodeUnknownOption(AgreedFile));
  if (Option.isSome(text) && Option.isNone(agreed)) yield* skipped;
  const rows = Object.entries(
    Option.match(agreed, { onNone: () => ({}), onSome: (doc) => doc.agreed }),
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
