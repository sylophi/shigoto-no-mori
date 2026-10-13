import { MirrorEventSchema } from "@shigomori/contracts/modules/mirror";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { countDropped, fileSyncDocument } from "./fileSyncFile.ts";

// Each mirror's thread of events (MirrorHistory.ts), by the local
// worktree it is keyed by, as the JSON array of its events, newest
// first. A 2.x data dir keeps them in file-sync/mirror-history.json,
// taken from it here: a thread that doesn't parse is skipped.
const ThreadSchema = Schema.Array(MirrorEventSchema);
const decodeThread = Schema.decodeUnknownOption(ThreadSchema);

export const mirrorHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mirror_history (
    worktree_id TEXT PRIMARY KEY,
    events TEXT NOT NULL
  ) STRICT`;
  const doc = yield* fileSyncDocument("mirror-history.json");
  const events = Option.match(doc, {
    onNone: () => undefined,
    onSome: (fields) => fields["events"],
  });
  const threads = Object.entries(
    typeof events === "object" && events !== null ? events : {},
  );
  const rows = threads.flatMap(([worktree_id, thread]) =>
    Option.match(decodeThread(thread), {
      onNone: () => [],
      onSome: (decoded) => [{ worktree_id, events: JSON.stringify(decoded) }],
    }),
  );
  yield* countDropped(
    "mirror-history.json",
    doc,
    "events",
    "object",
    threads.map(([, thread]) => thread),
    ThreadSchema,
  );
  if (rows.length > 0) {
    yield* sql`INSERT INTO mirror_history ${sql.insert(rows)}`;
  }
});
