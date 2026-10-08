import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The store's first schema: what registry.json, state.json, config.json
// and the per-project and per-worktree files held. Ids are kept as the
// text the JSON had. A worktree id is a hash of its path, so its rows
// have no foreign key: a mark outlives the checkout until it is cleared.
export const tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // In registration order, which the listing falls back to.
  yield* sql`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE
  ) STRICT`;
  // The sidebar's manual order. By path, since a project's path outlives
  // its registry entry (a project demoted to terrier keeps its place).
  yield* sql`CREATE TABLE project_order (
    path TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE
  ) STRICT`;
  yield* sql`CREATE TABLE worktree_marks (
    worktree_id TEXT NOT NULL,
    mark TEXT NOT NULL CHECK (mark IN ('shelved', 'autoPull')),
    PRIMARY KEY (worktree_id, mark)
  ) STRICT`;
  // What a shelved worktree looked like when it went on the shelf.
  yield* sql`CREATE TABLE shelf_snapshots (
    worktree_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    head TEXT,
    changed INTEGER NOT NULL
  ) STRICT`;
  // The id the app minted for this data dir.
  yield* sql`CREATE TABLE device (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL
  ) STRICT`;
  // Settings synced between devices, each entry the JSON it was written
  // as ({value, at, by}), kept even when this build can't read it.
  yield* sql`CREATE TABLE shared_settings (
    key TEXT PRIMARY KEY,
    entry TEXT NOT NULL
  ) STRICT`;
  // The device's and each project's settings, one JSON value per key as
  // stored. A key equal to its default has no row, and a key this build
  // doesn't model keeps its row.
  yield* sql`CREATE TABLE device_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`;
  yield* sql`CREATE TABLE project_config (
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
  ) STRICT`;
  // A worktree's title and description, and the ports the user added
  // (a JSON array).
  yield* sql`CREATE TABLE worktree_data (
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    title TEXT,
    description TEXT,
    described_at INTEGER,
    ports TEXT,
    PRIMARY KEY (project_id, worktree_id)
  ) STRICT`;
  // One row per use, in milliseconds: a project's actions (scope the
  // project id, name empty), a launcher's opens (scope empty, name the
  // launcher id), a package script's runs (scope the project id, name
  // the script).
  yield* sql`CREATE TABLE usage (
    log TEXT NOT NULL CHECK (log IN ('project', 'launcher', 'script')),
    scope TEXT NOT NULL,
    name TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT`;
  yield* sql`CREATE INDEX usage_by_name ON usage (log, scope, name)`;
  // A project's package script sort, absent for the default.
  yield* sql`CREATE TABLE script_sort (
    project_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL
  ) STRICT`;
  // A project's manual script order and its launch row, by name.
  yield* sql`CREATE TABLE script_lists (
    project_id TEXT NOT NULL,
    list TEXT NOT NULL CHECK (list IN ('order', 'launchRow')),
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (project_id, list, position)
  ) STRICT`;
});
