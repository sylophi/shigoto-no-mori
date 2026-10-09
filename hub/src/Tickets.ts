// The account's unconsumed connect tickets, in its Durable Object's
// own SQLite storage. Only the random half of a ticket lives here: the
// account half of the ticket string is routing the Worker handles.
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { randomBase64url } from "./crypto.ts";

// Upper bound on a single account's unconsumed tickets. A device that
// mints in a loop would otherwise grow the object's storage without
// limit. At the cap the soonest to expire go to make room. The store is
// per account, so a device minting in a loop can evict only its own
// account's tickets: that peer then gets CLOSE_TICKET_REJECTED at
// connect and mints again.
const MAX_UNCONSUMED_TICKETS = 64;

export class Tickets extends Context.Service<
  Tickets,
  {
    // Stores a fresh ticket for the device and answers its random half.
    readonly mint: (
      deviceId: string,
      ttlMs: number,
    ) => Effect.Effect<string, SqlError>;
    // Burns the ticket, answering the device it was minted for while it
    // is unexpired, so a replay or a late dial gets null.
    readonly take: (random: string) => Effect.Effect<string | null, SqlError>;
    // Drops the device's unconsumed tickets, at its revoke.
    readonly dropDevice: (deviceId: string) => Effect.Effect<void, SqlError>;
  }
>()("sm/hub/Tickets") {}

const migrations = SqliteMigrator.fromRecord({
  "0001_tickets": Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`CREATE TABLE tickets (
      random TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
  ),
});

const make = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: migrations });
  const sql = yield* SqlClient.SqlClient;

  const mint = Effect.fn("Tickets.mint")(function* (
    deviceId: string,
    ttlMs: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    // Expired tickets are garbage. Minting is the natural low-frequency
    // moment to sweep them, and to hold the live set under the cap.
    yield* sql`DELETE FROM tickets WHERE expires_at <= ${now}`;
    yield* sql`DELETE FROM tickets WHERE random IN (
      SELECT random FROM tickets ORDER BY expires_at
      LIMIT MAX(0, (SELECT COUNT(*) FROM tickets) - ${MAX_UNCONSUMED_TICKETS - 1})
    )`;
    const random = randomBase64url(16);
    yield* sql`INSERT INTO tickets ${sql.insert({
      random,
      device_id: deviceId,
      expires_at: now + ttlMs,
    })}`;
    return random;
  });

  const take = Effect.fn("Tickets.take")(function* (random: string) {
    const now = yield* Clock.currentTimeMillis;
    // Single use: the ticket is burned before any validity verdict, so
    // a replay races nothing.
    const rows = yield* sql<{
      device_id: string;
      expires_at: number;
    }>`DELETE FROM tickets WHERE random = ${random} RETURNING device_id, expires_at`;
    const [row] = rows;
    return row !== undefined && row.expires_at > now ? row.device_id : null;
  });

  const dropDevice = Effect.fn("Tickets.dropDevice")(function* (
    deviceId: string,
  ) {
    yield* sql`DELETE FROM tickets WHERE device_id = ${deviceId}`;
  });

  return Tickets.of({ mint, take, dropDevice });
});

export const layer = Layer.effect(Tickets, make);
