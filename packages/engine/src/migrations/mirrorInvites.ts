import { MirrorInviteSchema } from "@shigomori/contracts/modules/mirror";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { fileSyncDocument } from "./fileSyncFile.ts";
import { skip } from "./importJson.ts";

// The mirrors this device asked a peer for and that landed here
// (MirrorInvites.ts), in the order they were asked, each the JSON of a
// MirrorInvite. A 2.x data dir keeps them in file-sync/mirror-invites.json,
// taken from it here: one that doesn't parse, or never landed, is
// skipped.
const decodeInvite = Schema.decodeUnknownOption(MirrorInviteSchema);

export const mirrorInvites = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mirror_invites (
    position INTEGER PRIMARY KEY,
    invite TEXT NOT NULL
  ) STRICT`;
  const doc = yield* fileSyncDocument("mirror-invites.json");
  const invites = Option.match(doc, {
    onNone: () => undefined,
    onSome: (fields) => fields["invites"],
  });
  const listed = Array.isArray(invites) ? invites : [];
  const decoded = listed.flatMap((raw) =>
    Option.match(decodeInvite(raw), {
      onNone: () => [],
      onSome: (invite) => [invite],
    }),
  );
  // One that never landed is left out on purpose; one that doesn't
  // parse is a doubt.
  if (decoded.length < listed.length) {
    yield* skip("file-sync/mirror-invites.json", "invites");
  }
  const rows = decoded
    .filter((invite) => invite.copy !== undefined)
    .map((invite, position) => ({
      position,
      invite: JSON.stringify(invite),
    }));
  if (rows.length > 0) {
    yield* sql`INSERT INTO mirror_invites ${sql.insert(rows)}`;
  }
});
