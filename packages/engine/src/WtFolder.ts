// The one-time move of v2's worktrees into `wt/` that the store's
// `wtFolder` migration owes (migrations/wtFolder.ts). The first start
// looks through the v2 roots of every listed project, terrier's
// included, and records each folder there; then each is moved, one at
// a time, each inside a transaction so
// two processes starting together don't both take it. A move is
// `worktrees move`'s (git's move, a copy across volumes, the id carried
// over), then port-pool's lease re-made on the new path. One that can't
// be made keeps its folder and records why, for the doctor to report and
// retry. A crash between git's move and the carry-over finds the
// worktree at its new path on the next start and carries it then.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "./Config.ts";
import { findExecutable } from "./executables.ts";
import * as Git from "./Git.ts";
import * as Paths from "./Paths.ts";
import { parsePortPoolConfig, PORT_POOL_CONFIG } from "./ports.ts";
import * as Registry from "./Registry.ts";
import { externalVolumeRoot, worktreeIdFromPath } from "./worktreeLayout.ts";
import * as Worktrees from "./Worktrees.ts";

// A worktree still in its v2 folder, and why when a move failed.
export type Unmoved = {
  readonly fromPath: string;
  readonly toPath: string;
  readonly projectId: string;
  readonly error: string | null;
};

export class WtFolder extends Context.Service<
  WtFolder,
  {
    // Every recorded move not made yet.
    readonly drain: Effect.Effect<void>;
    readonly unmoved: Effect.Effect<ReadonlyArray<Unmoved>>;
    // Tries the moves of one project again. Answers the ones still
    // unmade.
    readonly retry: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<Unmoved>>;
    // Where the migration moved a v2 folder, for state kept by its path.
    readonly movedTo: (
      fromPath: string,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("sm/engine/WtFolder") {}

type Row = {
  readonly from_path: string;
  readonly to_path: string;
  readonly project_id: string;
  readonly error: string | null;
};

const unmovedOf = (row: Row): Unmoved => ({
  fromPath: row.from_path,
  toPath: row.to_path,
  projectId: row.project_id,
  error: row.error,
});

// What a failure says, git's own words for a git that failed.
const why = (error: { readonly message: string }) =>
  error instanceof Git.GitCommandError
    ? Git.stderrOf(error).trim() || error.message
    : error.message;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.Git;
  const config = yield* Config.Config;
  const registry = yield* Registry.Registry;
  const worktrees = yield* Worktrees.Worktrees;
  const { dataDir, dataDirName } = yield* Paths.Paths;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  // port-pool keys a lease by its folder: the old one's goes, and the
  // new folder gets its own (its ports may differ). A failure leaves the
  // move made and is only logged.
  const carryLease = (from: string, to: string) =>
    Effect.gen(function* () {
      const enabled = (yield* config
        .get({ kind: "device" }, "portPool")
        .pipe(Effect.orElseSucceed(() => ({ value: false })))).value;
      if (enabled !== true) return;
      if (
        Option.isNone(
          yield* findExecutable("port-pool").pipe(
            Effect.provideContext(platform),
          ),
        )
      ) {
        return;
      }
      const text = yield* fs
        .readFileString(path.join(to, PORT_POOL_CONFIG))
        .pipe(Effect.option, Effect.map(Option.getOrUndefined));
      if (!parsePortPoolConfig(text).configured) return;
      for (const args of [
        ["release", from],
        ["ensure", to],
      ]) {
        const code = yield* spawner.exitCode(
          ChildProcess.make("port-pool", args),
        );
        if (code !== 0) {
          yield* Effect.logWarning("port-pool failed after a move").pipe(
            Effect.annotateLogs({ args: args.join(" "), code }),
          );
        }
      }
    }).pipe(Effect.ignore);

  // One recorded move, made or failed, inside a transaction that holds
  // the store's write lock, which another process waits on.
  const moveOne = (project: Registry.RegisteredProject, fromPath: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<Row>`
          UPDATE wt_moves SET error = error
          WHERE from_path = ${fromPath} AND moved = 0
          RETURNING from_path, to_path, project_id, error`;
        if (row === undefined) return;
        const listed = yield* worktrees.identities(project).pipe(Effect.result);
        if (Result.isFailure(listed)) {
          yield* sql`UPDATE wt_moves SET error = ${why(listed.failure)}
            WHERE from_path = ${fromPath}`;
          return;
        }
        // git spells a path with its symlinks resolved.
        const at = (p: string) =>
          Effect.map(
            fs.realPath(p).pipe(Effect.orElseSucceed(() => p)),
            (real) =>
              listed.success.find((id) => id.path === p || id.path === real),
          );
        const from = yield* at(row.from_path);
        const there = from === undefined ? yield* at(row.to_path) : undefined;
        let movedTo: string;
        if (from !== undefined) {
          const moved = yield* worktrees
            .move({ project, worktree: from }, row.to_path)
            .pipe(Effect.result);
          if (Result.isFailure(moved)) {
            yield* sql`UPDATE wt_moves SET error = ${why(moved.failure)}
              WHERE from_path = ${fromPath}`;
            return;
          }
          movedTo = moved.success.worktree.path;
        } else if (there !== undefined) {
          // git moved it before a crash; the carry-over is still owed.
          yield* worktrees.rekey(
            project,
            worktreeIdFromPath(row.from_path),
            there.path,
          );
          movedTo = there.path;
        } else {
          // Not a worktree git lists: a stray folder stays where it is.
          yield* sql`DELETE FROM wt_moves WHERE from_path = ${fromPath}`;
          return;
        }
        yield* carryLease(row.from_path, movedTo);
        // As git spells it, which the new id is a hash of.
        yield* sql`UPDATE wt_moves SET moved = 1, error = NULL, to_path = ${movedTo}
          WHERE from_path = ${fromPath}`;
      }),
    );

  // rmdir, which takes only an empty folder.
  const removeEmpty = (dir: string) =>
    spawner.exitCode(ChildProcess.make("rmdir", [dir])).pipe(
      Effect.map((code) => code === 0),
      Effect.orElseSucceed(() => false),
    );

  // The project's moves, the failed ones too with `again`.
  const moveProject = (projectId: string, again: boolean) =>
    Effect.gen(function* () {
      const project = (yield* registry.listed).find(
        ({ id }) => id === projectId,
      );
      const rows = (yield* sql<Row>`
        SELECT from_path, to_path, project_id, error FROM wt_moves
        WHERE project_id = ${projectId} AND moved = 0`).filter(
        (row) => again || row.error === null,
      );
      if (project === undefined || rows.length === 0) return;
      for (const row of rows) yield* moveOne(project, row.from_path);
      yield* git.run(project.path, ["worktree", "repair"]).pipe(Effect.ignore);
      // The emptied v2 roots, and the `worktrees` folder above one.
      const roots = new Set(rows.map((row) => path.dirname(row.from_path)));
      for (const root of roots) {
        if (!(yield* removeEmpty(root))) continue;
        const above = path.dirname(root);
        if (path.basename(above) === "worktrees") yield* removeEmpty(above);
      }
    }).pipe(Effect.orDie);

  const unmoved = sql<Row>`
    SELECT from_path, to_path, project_id, error FROM wt_moves
    WHERE moved = 0 ORDER BY from_path`.pipe(
    Effect.map((rows) => rows.map(unmovedOf)),
    Effect.orDie,
  );

  // Each v2 root of a project, beside the `wt/` one its worktrees go to:
  // the managed root under the data dir, the in-project folder, and the
  // drive's when the project is on one.
  const rootsOf = (projectPath: string) => {
    const name = path.basename(projectPath);
    const volume = externalVolumeRoot(projectPath);
    return [
      [path.join(dataDir, "worktrees", name), path.join(dataDir, "wt", name)],
      [
        path.join(projectPath, ".shigomori", "worktrees"),
        path.join(projectPath, ".shigomori", "wt"),
      ],
      ...(volume === undefined
        ? []
        : [
            [
              path.join(volume, dataDirName, "worktrees", name),
              path.join(volume, dataDirName, "wt", name),
            ],
          ]),
    ] as const;
  };

  // The folders under the v2 roots, recorded once. A folder git doesn't
  // list is dropped when its move is tried.
  const scan = sql.withTransaction(
    Effect.gen(function* () {
      const owed = yield* sql`DELETE FROM wt_move_scan RETURNING id`;
      if (owed.length === 0) return;
      for (const project of yield* registry.listed) {
        for (const [from, to] of rootsOf(project.path)) {
          const children = yield* fs
            .readDirectory(from)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          for (const child of children) {
            // As git spells it (symlinks resolved), which the id it has
            // now is a hash of.
            const at = path.join(from, child);
            yield* sql`INSERT INTO wt_moves ${sql.insert({
              from_path: yield* fs
                .realPath(at)
                .pipe(Effect.orElseSucceed(() => at)),
              to_path: path.join(to, child),
              project_id: project.id,
            })} ON CONFLICT DO NOTHING`;
          }
        }
      }
    }),
  );

  const drain = Effect.gen(function* () {
    yield* scan.pipe(Effect.orDie);
    const pending = yield* sql<{ project_id: string }>`
      SELECT DISTINCT project_id FROM wt_moves
      WHERE moved = 0 AND error IS NULL`.pipe(Effect.orDie);
    for (const { project_id } of pending) {
      yield* moveProject(project_id, false);
    }
  }).pipe(Effect.withSpan("WtFolder.drain"));

  const retry = Effect.fn("WtFolder.retry")(function* (projectId: string) {
    yield* moveProject(projectId, true);
    return (yield* unmoved).filter((row) => row.projectId === projectId);
  });

  const movedTo = Effect.fn("WtFolder.movedTo")(function* (fromPath: string) {
    const [row] = yield* sql<{ to_path: string }>`
      SELECT to_path FROM wt_moves WHERE from_path = ${fromPath} AND moved = 1`.pipe(
      Effect.orDie,
    );
    return Option.fromNullishOr(row?.to_path);
  });

  return WtFolder.of({ drain, unmoved, retry, movedTo });
});

export const layer = Layer.effect(WtFolder, make);

// The moves made before anything else runs, for the engine's processes.
export const drained = Layer.effectDiscard(
  Effect.flatMap(Effect.service(WtFolder), (folder) => folder.drain),
);
