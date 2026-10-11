import { GitStateCoreSchema } from "@shigomori/contracts/modules/mirror";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export type GitStateCore = typeof GitStateCoreSchema.Type;

const StateJson = Schema.fromJsonString(GitStateCoreSchema);
const decodeState = Schema.decodeUnknownOption(StateJson);
const encodeState = Schema.encodeSync(StateJson);

// The git state each mirror session's two sides last agreed on, which
// the host's git follower reads at start and writes as it changes, so a
// restart resumes the follow rule rather than falling back to ancestry.
export class MirrorAgreements extends Context.Service<
  MirrorAgreements,
  {
    // By session id. A row this build can't read is left out.
    readonly load: Effect.Effect<Record<string, GitStateCore>>;
    // Replaces every agreement with `agreed`.
    readonly save: (
      agreed: Record<string, GitStateCore>,
    ) => Effect.Effect<void>;
  }
>()("sm/engine/MirrorAgreements") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const load = sql<{
    session: string;
    state: string;
  }>`SELECT session, state FROM mirror_agreements`.pipe(
    Effect.map((rows) =>
      Object.fromEntries(
        rows.flatMap((row) =>
          Option.match(decodeState(row.state), {
            onNone: () => [],
            onSome: (state) => [[row.session, state] as const],
          }),
        ),
      ),
    ),
    Effect.orDie,
    Effect.withSpan("MirrorAgreements.load"),
  );

  const save = Effect.fn("MirrorAgreements.save")(function* (
    agreed: Record<string, GitStateCore>,
  ) {
    const rows = Object.entries(agreed).map(([session, state]) => ({
      session,
      state: encodeState(state),
    }));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM mirror_agreements`;
        if (rows.length > 0) {
          yield* sql`INSERT INTO mirror_agreements ${sql.insert(rows)}`;
        }
      }),
    );
  }, Effect.orDie);

  return MirrorAgreements.of({ load, save });
});

export const layer = Layer.effect(MirrorAgreements, make);
