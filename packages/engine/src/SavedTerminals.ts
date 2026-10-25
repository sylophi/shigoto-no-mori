import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// A terminal as the host last saved it, while it ran or as it closed:
// its worktree (none for the device's), the folder its shell was in,
// and the tail of what it showed, which the next start replays above a
// fresh shell there.
export type SavedTerminal = {
  readonly terminalId: string;
  readonly worktree?: {
    readonly projectId: string;
    readonly worktreeId: string;
  };
  readonly cwd: string;
  readonly openedAt: number;
  readonly seq: number;
  readonly history: string;
};

export class SavedTerminals extends Context.Service<
  SavedTerminals,
  {
    // Every saved terminal, oldest first.
    readonly list: Effect.Effect<ReadonlyArray<SavedTerminal>>;
    readonly save: (terminal: SavedTerminal) => Effect.Effect<void>;
    readonly forget: (terminalId: string) => Effect.Effect<void>;
  }
>()("sm/engine/SavedTerminals") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const list = sql<{
    terminal_id: string;
    project_id: string | null;
    worktree_id: string | null;
    cwd: string;
    opened_at: number;
    seq: number;
    history: string;
  }>`SELECT * FROM saved_terminals ORDER BY opened_at, terminal_id`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        terminalId: row.terminal_id,
        ...(row.project_id !== null &&
          row.worktree_id !== null && {
            worktree: {
              projectId: row.project_id,
              worktreeId: row.worktree_id,
            },
          }),
        cwd: row.cwd,
        openedAt: row.opened_at,
        seq: row.seq,
        history: row.history,
      })),
    ),
    Effect.orDie,
    Effect.withSpan("SavedTerminals.list"),
  );

  const save = Effect.fn("SavedTerminals.save")(function* (
    terminal: SavedTerminal,
  ) {
    const row = {
      terminal_id: terminal.terminalId,
      project_id: terminal.worktree?.projectId ?? null,
      worktree_id: terminal.worktree?.worktreeId ?? null,
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

  return SavedTerminals.of({ list, save, forget });
});

export const layer = Layer.effect(SavedTerminals, make);
