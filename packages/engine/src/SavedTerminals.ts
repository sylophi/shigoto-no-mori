import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  type TerminalOwner,
  TerminalOwnerSchema,
} from "@shigomori/contracts/schemas";

// A terminal as the host left it at a quit: where it was, and the tail
// of what it showed, which the next start replays above a fresh shell.
export type SavedTerminal = {
  readonly terminalId: string;
  readonly owner: TerminalOwner;
  readonly cwd: string;
  readonly openedAt: number;
  readonly seq: number;
  readonly history: string;
};

const OwnerJson = Schema.fromJsonString(TerminalOwnerSchema);
const decodeOwner = Schema.decodeUnknownOption(OwnerJson);
const encodeOwner = Schema.encodeSync(OwnerJson);

export class SavedTerminals extends Context.Service<
  SavedTerminals,
  {
    // Every saved terminal, oldest first. A row whose owner this build
    // can't read is left out.
    readonly list: Effect.Effect<ReadonlyArray<SavedTerminal>>;
    readonly save: (terminal: SavedTerminal) => Effect.Effect<void>;
    readonly forget: (terminalId: string) => Effect.Effect<void>;
    // The folder the device's last terminal was in.
    readonly lastFolder: Effect.Effect<Option.Option<string>>;
    readonly setLastFolder: (path: string) => Effect.Effect<void>;
  }
>()("sm/engine/SavedTerminals") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const list = Effect.gen(function* () {
    const rows = yield* sql<{
      terminal_id: string;
      owner: string;
      cwd: string;
      opened_at: number;
      seq: number;
      history: string;
    }>`SELECT * FROM saved_terminals ORDER BY opened_at, terminal_id`;
    return rows.flatMap((row) =>
      Option.match(decodeOwner(row.owner), {
        onNone: () => [],
        onSome: (owner) => [
          {
            terminalId: row.terminal_id,
            owner,
            cwd: row.cwd,
            openedAt: row.opened_at,
            seq: row.seq,
            history: row.history,
          },
        ],
      }),
    );
  }).pipe(Effect.orDie, Effect.withSpan("SavedTerminals.list"));

  const save = Effect.fn("SavedTerminals.save")(function* (
    terminal: SavedTerminal,
  ) {
    const row = {
      terminal_id: terminal.terminalId,
      owner: encodeOwner(terminal.owner),
      cwd: terminal.cwd,
      opened_at: terminal.openedAt,
      seq: terminal.seq,
      history: terminal.history,
    };
    yield* sql`INSERT OR REPLACE INTO saved_terminals ${sql.insert(row)}`;
  }, Effect.orDie);

  const forget = Effect.fn("SavedTerminals.forget")(function* (
    terminalId: string,
  ) {
    yield* sql`DELETE FROM saved_terminals WHERE terminal_id = ${terminalId}`;
  }, Effect.orDie);

  const lastFolder = sql<{
    path: string;
  }>`SELECT path FROM terminal_folder WHERE id = 1`.pipe(
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.path)),
    Effect.orDie,
    Effect.withSpan("SavedTerminals.lastFolder"),
  );

  const setLastFolder = Effect.fn("SavedTerminals.setLastFolder")(function* (
    path: string,
  ) {
    yield* sql`INSERT OR REPLACE INTO terminal_folder ${sql.insert({ id: 1, path })}`;
  }, Effect.orDie);

  return SavedTerminals.of({ list, save, forget, lastFolder, setLastFolder });
});

export const layer = Layer.effect(SavedTerminals, make);
