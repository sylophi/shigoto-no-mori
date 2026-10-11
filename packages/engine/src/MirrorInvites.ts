import {
  type MirrorInvite,
  MirrorInviteSchema,
} from "@shigomori/contracts/modules/mirror";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const InviteJson = Schema.fromJsonString(MirrorInviteSchema);
const decodeInvite = Schema.decodeUnknownOption(InviteJson);
const encodeInvite = Schema.encodeSync(InviteJson);

// The mirrors this device asked a peer for that landed here, which the
// host's device link admits the peer's calls under (its
// mirror/invites.ts): read at start, written as they change, so a
// relaunch still serves the mirrors it asked for.
export class MirrorInvites extends Context.Service<
  MirrorInvites,
  {
    // In the order they were asked. One this build can't read is left
    // out.
    readonly load: Effect.Effect<ReadonlyArray<MirrorInvite>>;
    // Replaces every invitation with `invites`.
    readonly save: (
      invites: ReadonlyArray<MirrorInvite>,
    ) => Effect.Effect<void>;
  }
>()("sm/engine/MirrorInvites") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const load = sql<{
    invite: string;
  }>`SELECT invite FROM mirror_invites ORDER BY position`.pipe(
    Effect.map((rows) =>
      rows.flatMap((row) =>
        Option.match(decodeInvite(row.invite), {
          onNone: () => [],
          onSome: (invite) => [invite],
        }),
      ),
    ),
    Effect.orDie,
    Effect.withSpan("MirrorInvites.load"),
  );

  const save = Effect.fn("MirrorInvites.save")(function* (
    invites: ReadonlyArray<MirrorInvite>,
  ) {
    const rows = invites.map((invite, position) => ({
      position,
      invite: encodeInvite(invite),
    }));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM mirror_invites`;
        if (rows.length > 0) {
          yield* sql`INSERT INTO mirror_invites ${sql.insert(rows)}`;
        }
      }),
    );
  }, Effect.orDie);

  return MirrorInvites.of({ load, save });
});

export const layer = Layer.effect(MirrorInvites, make);
