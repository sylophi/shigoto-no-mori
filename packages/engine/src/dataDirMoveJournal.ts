// The journal a data-folder move keeps in the data dir while it runs
// (the app's host/lib/dataDirMove.ts), and the start that finds a move a
// crash cut between its rename and its pointer (Paths.ts), which every
// process runs before it opens a store.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
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
      // The commit of the worktree's dirty capture before the re-key,
      // null for none: an undo carries back that one alone.
      capture: Schema.NullOr(Schema.String),
      // How far the entry got.
      state: Schema.Literals(["planned", "rekeyed", "returned"]),
    }),
  ),
});
export type Journal = typeof Journal.Type;
export const JournalJson = Schema.fromJsonString(Journal);

// The journal written whole to `file`: beside itself, flushed to disk,
// renamed in and the rename flushed, so neither a crash nor a lost
// power leaves a journal half written or a step it records undone.
export const writeJournal = (file: string, journal: Journal) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.dirname(file);
    const staged = `${file}.tmp`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(staged, { flag: "w", mode: 0o600 });
        yield* handle.writeAll(
          new TextEncoder().encode(Schema.encodeSync(JournalJson)(journal)),
        );
        yield* handle.sync;
      }),
    );
    yield* fs.rename(staged, file);
    // A folder's own flush, where the platform takes one.
    yield* Effect.scoped(
      Effect.flatMap(fs.open(dir, { flag: "r" }), (handle) => handle.sync),
    ).pipe(Effect.ignore);
  });

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
      const published = yield* (
        file === null
          ? fs.remove(pointerFile, { force: true })
          : fs.rename(file, pointerFile)
      ).pipe(Effect.result);
      if (Result.isFailure(published)) {
        // Another process may have made the same rescue first; otherwise
        // the data dir is where no pointer leads, which no fallback to the
        // folder that left may hide.
        const now = yield* fs.readFileString(pointerFile).pipe(
          Effect.map((text) => text.trim()),
          Effect.orElseSucceed(() => null),
        );
        const committed =
          file === null
            ? now === null
            : now !== null && path.resolve(now) === path.resolve(at);
        if (!committed) {
          return yield* new DataDirStranded({
            from: named,
            to: at,
            pointer: pointerFile,
            reason: published.failure.message,
          });
        }
      }
      // The pre-2.0 pointer is read once the current one is gone, so one
      // left naming the folder that left would lead back to it.
      if (legacyPointerFile !== null) {
        const removed = yield* fs
          .remove(legacyPointerFile, { force: true })
          .pipe(Effect.result);
        if (
          Result.isFailure(removed) &&
          (yield* fs
            .exists(legacyPointerFile)
            .pipe(Effect.orElseSucceed(() => true)))
        ) {
          return yield* new DataDirStranded({
            from: named,
            to: at,
            pointer: legacyPointerFile,
            reason: removed.failure.message,
          });
        }
      }
      return at;
    }
    return null;
  });

// A data folder a move landed whose pointer couldn't be made to lead to
// it: every process refuses to start rather than make a fresh one where
// the pointer still leads.
class DataDirStranded extends Schema.TaggedError<DataDirStranded>()(
  "DataDirStranded",
  {
    from: Schema.String,
    to: Schema.String,
    pointer: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `The data folder moved from ${this.from} to ${this.to}, and the pointer at ${this.pointer} couldn't be updated (${this.reason}). Make that file's folder writable, or put ${this.to} in it.`;
  }
}

const WRITES = ["INSERT", "UPDATE", "DELETE"];

const tablesOf = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    (rows) => rows.map(({ name }) => name),
  );

// The store made to refuse every write but its owner's, while a move's
// journal is here (dataDirMove.ts).
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

// Whether the store refuses writes, as a move left it.
export const retired = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const triggers = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND substr(name, 1, 6) = 'moved_' LIMIT 1`;
  return triggers.length > 0;
});

// The store a move left let write again.
export const reviveStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const triggers = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND substr(name, 1, 6) = 'moved_'`;
  for (const { name } of triggers) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS "${name}"`);
  }
});
