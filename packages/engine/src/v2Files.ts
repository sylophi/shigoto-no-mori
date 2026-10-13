// The files a 2.x data dir keeps its state in, which the store's import
// reads (migrations/importJson.ts and the migrations after it). Once an
// import is verified the migration deletes them (Store.ts), and the
// doctor offers to delete any left over.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
