// The journal a data-folder move keeps in the data dir while it runs
// (the app's host/lib/dataDirMove.ts), and the start that finds a move a
// crash cut between its rename and its pointer (Paths.ts), which every
// process runs before it opens a store.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { MOVED } from "./storeErrors.ts";

export const JOURNAL = "data-dir-move.json";
export const Journal = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  // The sibling a copy to another volume fills, null for a rename.
  partial: Schema.NullOr(Schema.String),
  moved: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      oldPath: Schema.String,
      newPath: Schema.String,
    }),
  ),
});
export type Journal = typeof Journal.Type;
export const JournalJson = Schema.fromJsonString(Journal);

// A rename whose folder landed but whose pointer never moved: the
// pointer (or its absence) still names `named`, the folder that left,
// which is gone, and the journal at the destination names it as its
// source. A copy keeps its source, whose journal undoes it instead, so
// only a rename's journal counts. The destination is the pointer's
// staged copy's target, or the default location, which needs no
// pointer. The pointer is committed as the move would have, and the
// destination answered, for the host's resume to finish the rest.
export const rescueStrandedMove = (input: {
  readonly named: string;
  readonly pointerFile: string;
  readonly legacyPointerFile: string | null;
  readonly defaultDataDir: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { named, pointerFile, legacyPointerFile, defaultDataDir } = input;
    const there = (file: string) =>
      fs.exists(file).pipe(Effect.orElseSucceed(() => true));
    if (yield* there(named)) return null;
    const dir = path.dirname(pointerFile);
    const staged = (yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
      .filter((entry) => entry.startsWith(`${path.basename(pointerFile)}.tmp.`))
      .map((entry) => path.join(dir, entry));
    const candidates: Array<{ file: string | null; at: string }> = [];
    for (const file of staged) {
      const at = yield* fs
        .readFileString(file)
        .pipe(Effect.orElseSucceed(() => ""));
      candidates.push({ file, at: at.trim() });
    }
    candidates.push({ file: null, at: defaultDataDir });
    for (const { file, at } of candidates) {
      if (at === "" || path.resolve(at) === path.resolve(named)) continue;
      const journal = yield* fs.readFileString(path.join(at, JOURNAL)).pipe(
        Effect.map(Schema.decodeUnknownOption(JournalJson)),
        Effect.orElseSucceed(() => Option.none<Journal>()),
      );
      if (
        Option.isNone(journal) ||
        journal.value.partial !== null ||
        path.resolve(journal.value.from) !== path.resolve(named) ||
        path.resolve(journal.value.to) !== path.resolve(at)
      ) {
        continue;
      }
      yield* file === null
        ? fs.remove(pointerFile, { force: true })
        : fs.rename(file, pointerFile);
      if (legacyPointerFile !== null) {
        yield* fs.remove(legacyPointerFile, { force: true });
      }
      return at;
    }
    return null;
  }).pipe(Effect.orElseSucceed(() => null));

const WRITES = ["INSERT", "UPDATE", "DELETE"];

const tablesOf = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    (rows) => rows.map(({ name }) => name),
  );

// The store a copy across volumes leaves behind made to refuse every
// write, before the move lets go of its lock: a write that waited on it
// fails rather than landing where the move is about to retire.
export const retireStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of yield* tablesOf(sql)) {
    for (const op of WRITES) {
      // Names can't be bound, and these are the store's own.
      yield* sql.unsafe(
        `CREATE TRIGGER IF NOT EXISTS "moved_${table}_${op}" BEFORE ${op} ON "${table}" BEGIN SELECT RAISE(ABORT, '${MOVED}'); END`,
      );
    }
  }
});

// The store a move left let write again, for a move undone: in the
// process that undoes it, and as the store opens where a journal says a
// move was cut short (Store.ts).
export const reviveStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const triggers = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND substr(name, 1, 6) = 'moved_'`;
  for (const { name } of triggers) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS "${name}"`);
  }
});
