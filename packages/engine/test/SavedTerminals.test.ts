import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { it } from "vitest";
import { terminals } from "../src/migrations/terminals.ts";
import * as SavedTerminals from "../src/SavedTerminals.ts";
import { freshDataDir, onStoreAt } from "./lib/nodeStore.ts";

const dataDir = freshDataDir("engine-terminals-");

const run = <A>(
  program: Effect.Effect<
    A,
    never,
    SavedTerminals.SavedTerminals | SqlClient.SqlClient
  >,
) =>
  program.pipe(
    Effect.provide(SavedTerminals.layer.pipe(onStoreAt(dataDir()))),
    Effect.runPromise,
  );

const worktreeTerminal: SavedTerminals.SavedTerminal = {
  terminalId: "b",
  projectId: "P",
  worktreeId: "W",
  cwd: "/code/app",
  openedAt: 2,
  seq: 7,
  history: "$ vim\r\n",
};

it("opens a store holding a saved device terminal, keeping its worktrees' and dropping the device's", async () => {
  // The store as a build before migration 15 left it: the terminals'
  // tables of migration 6, a device terminal saved beside a worktree's,
  // and the device's last folder.
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE saved_terminals`;
      yield* sql`ALTER TABLE running_scripts DROP COLUMN group_leader`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 15`;
      yield* terminals;
      yield* sql`INSERT INTO saved_terminals ${sql.insert([
        {
          terminal_id: "a",
          owner: '{"kind":"device"}',
          cwd: "/Users/sam",
          opened_at: 1,
          seq: 3,
          history: "$ ls\r\n",
        },
        {
          terminal_id: "b",
          owner: '{"kind":"worktree","projectId":"P","worktreeId":"W"}',
          cwd: "/code/app",
          opened_at: 2,
          seq: 7,
          history: "$ vim\r\n",
        },
      ])}`;
      yield* sql`INSERT INTO terminal_folder ${sql.insert({ id: 1, path: "/Users/sam" })}`;
    }).pipe(Effect.orDie),
  );
  const opened = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ name: string }>`SELECT name
        FROM sqlite_schema WHERE type = 'table' AND name LIKE '%terminal%'`;
      return {
        listed: yield* (yield* SavedTerminals.SavedTerminals).list,
        tables: tables.map((table) => table.name),
      };
    }).pipe(Effect.orDie),
  );
  assert.deepEqual(opened, {
    listed: [worktreeTerminal],
    tables: ["saved_terminals"],
  });
});
