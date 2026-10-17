// The files a 2.x data dir keeps its state in, which the store's import
// reads (migrations/importJson.ts and the migrations after it). Once an
// import is verified the migration deletes them (Store.ts), and the
// doctor offers to delete any left over.
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Paths from "./Paths.ts";
import { isAbsent } from "./platformErrors.ts";

const AT_THE_TOP = [
  "registry.json",
  "config.json",
  "state.json",
  "running-scripts.json",
  "file-sync/git-follow.json",
  "file-sync/mirror-history.json",
  "file-sync/mirror-invites.json",
];

// The files there now: the ones above, each project's project.json and
// its worktrees' files.
export const v2Files = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { dataDir } = yield* Paths.Paths;
  const listed = (dir: string) =>
    fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const candidates = AT_THE_TOP.map((file) => path.join(dataDir, file));
  const projects = path.join(dataDir, "projects");
  for (const id of (yield* listed(projects)).toSorted()) {
    candidates.push(path.join(projects, id, "project.json"));
    const worktrees = path.join(projects, id, "worktrees");
    for (const file of (yield* listed(worktrees)).toSorted()) {
      if (file.endsWith(".json")) candidates.push(path.join(worktrees, file));
    }
  }
  return yield* Effect.filter(candidates, (file) =>
    fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
  );
});

// Each of `files` by its content's hash, for telling a file the import
// verified from one written since. One that can't be read has none.
export const hashesOf = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hashes: Record<string, string> = {};
    for (const file of files) {
      const bytes = yield* fs
        .readFile(file)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (bytes !== undefined) {
        hashes[file] = createHash("sha256").update(bytes).digest("hex");
      }
    }
    return hashes;
  });

// Whether two hash maps name the same files with the same content.
export const sameHashes = (
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([file, hash]) => b[file] === hash);

// What a verified import found each file as, by its hash: the store's
// record, which the doctor reads to tell a file the store holds.
const VerifiedFiles = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.String),
);

export const recordVerified = (hashes: Readonly<Record<string, string>>) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT OR REPLACE INTO v2_import (id, files)
      VALUES (1, ${Schema.encodeSync(VerifiedFiles)(hashes)})`,
  );

// The ones of `files` the store holds: each as the import verified it,
// unchanged since. None without a verified import, or with a record
// that can't be read.
export const heldV2Files = Effect.fnUntraced(function* (
  files: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ files: string }>`
    SELECT files FROM v2_import`.pipe(
    Effect.orElseSucceed((): ReadonlyArray<{ files: string }> => []),
  );
  const verified =
    row === undefined
      ? {}
      : Option.getOrElse(
          Schema.decodeUnknownOption(VerifiedFiles)(row.files),
          () => ({}),
        );
  const now = yield* hashesOf(files);
  return files.filter(
    (file) => now[file] !== undefined && now[file] === verified[file],
  );
});

// `files` deleted, and the projects' folders they leave empty.
export const removeV2Files = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dataDir } = yield* Paths.Paths;
    for (const file of files) {
      yield* fs.remove(file).pipe(Effect.catchIf(isAbsent, () => Effect.void));
    }
    const projects = path.join(dataDir, "projects");
    const emptied = (dir: string) =>
      fs.readDirectory(dir).pipe(
        Effect.flatMap((entries) =>
          // Empty, so recursive takes nothing more than the folder.
          entries.length === 0
            ? fs.remove(dir, { recursive: true })
            : Effect.void,
        ),
        Effect.ignore,
      );
    const ids = yield* fs
      .readDirectory(projects)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const id of ids) {
      yield* emptied(path.join(projects, id, "worktrees"));
      yield* emptied(path.join(projects, id));
    }
    yield* emptied(projects);
  });
