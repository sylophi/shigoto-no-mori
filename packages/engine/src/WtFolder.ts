// The one-time move of v2's worktrees into `wt/` that the store's
// `wtFolder` migration owes (migrations/wtFolder.ts). The first start
// looks through the v2 roots of every listed project, terrier's
// included, and records each folder there. Each is then moved as
// `worktrees move` moves one, inside a transaction so two processes
// starting together don't both take it. One that can't be moved keeps
// its folder and records why, for the doctor to report and retry. A
// crash between git's move and the carry-over finds the worktree at its
// new path on the next start and carries it then. The first start's
// moves are reported to the migration as they go (Migration.ts), and
// a start that resumes them counts the ones made before.
import type { WorktreeMoveStep } from "@shigomori/contracts/schemas/migration";
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
import * as Git from "./Git.ts";
import * as Migration from "./Migration.ts";
import * as Paths from "./Paths.ts";
import * as Registry from "./Registry.ts";
import { externalVolumeRoot } from "./worktreeLayout.ts";
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
    // Where a worktree's folder went, moved by the migration, `worktrees
    // move` or a rename, for state kept by its path.
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

// git's first line, without its "fatal:" and trailing punctuation.
const oneLine = (error: string) =>
  (
    error
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? error
  )
    .replace(/^(fatal|error): /, "")
    .replace(/[;:,.]$/, "");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.Git;
  const registry = yield* Registry.Registry;
  const worktrees = yield* Worktrees.Worktrees;
  const { dataDir, dataDirName } = yield* Paths.Paths;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const migration = yield* Migration.Migration;

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
        // A move records itself as made (Worktrees.carryMoved).
        const made =
          from !== undefined
            ? Effect.asVoid(
                worktrees.move({ project, worktree: from }, row.to_path),
              )
            : (yield* at(row.to_path)) !== undefined
              ? // git moved it before a crash; the carry-over is still owed.
                Effect.asVoid(
                  worktrees.carryMoved(project, row.from_path, row.to_path),
                )
              : undefined;
        if (made === undefined) {
          // Not a worktree git lists: a stray folder stays where it is.
          yield* sql`DELETE FROM wt_moves WHERE from_path = ${fromPath}`;
          return;
        }
        const outcome = yield* Effect.result(made);
        if (Result.isFailure(outcome)) {
          yield* sql`UPDATE wt_moves SET error = ${why(outcome.failure)}
            WHERE from_path = ${fromPath}`;
        }
      }),
    );

  // rmdir, which takes only an empty folder.
  const removeEmpty = (dir: string) =>
    spawner.exitCode(ChildProcess.make("rmdir", [dir])).pipe(
      Effect.map((code) => code === 0),
      Effect.orElseSucceed(() => false),
    );

  // The project's moves, the failed ones too with `again`. `report`
  // hears each move before and after it is tried.
  const moveProject = (
    projectId: string,
    again: boolean,
    report?: (fromPath: string, tried: boolean) => Effect.Effect<void>,
  ) =>
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
      for (const row of rows) {
        yield* report?.(row.from_path, false) ?? Effect.void;
        yield* moveOne(project, row.from_path);
        yield* report?.(row.from_path, true) ?? Effect.void;
      }
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

  // A row's outcome as the step counts it: moved, stuck with git's
  // first line, or gone (a stray folder git doesn't list).
  const outcomeOf = (fromPath: string) =>
    sql<{ moved: number; error: string | null }>`
      SELECT moved, error FROM wt_moves WHERE from_path = ${fromPath}`.pipe(
      Effect.map(([row]) => row),
      Effect.orDie,
    );
  const stuckOf = (fromPath: string, error: string) => ({
    name: path.basename(fromPath),
    reason: oneLine(error),
  });

  // The migration's moves: the rows the scan recorded under a v2 root,
  // made or not, as git spells the root.
  const migrationRows = Effect.gen(function* () {
    const roots = new Set<string>();
    for (const project of yield* registry.listed) {
      for (const [from] of rootsOf(project.path)) {
        roots.add(from);
        roots.add(
          yield* fs.realPath(from).pipe(Effect.orElseSucceed(() => from)),
        );
      }
    }
    const rows = yield* sql<Row & { readonly moved: number }>`
      SELECT from_path, to_path, project_id, error, moved FROM wt_moves`;
    return rows.filter((row) => roots.has(path.dirname(row.from_path)));
  });

  const moving = (f: (step: WorktreeMoveStep) => WorktreeMoveStep) =>
    migration.update((current) =>
      current.worktrees === null
        ? current
        : { ...current, worktrees: f(current.worktrees) },
    );

  const report = (fromPath: string, tried: boolean) =>
    Effect.gen(function* () {
      if (!tried) {
        return yield* moving((step) => ({
          ...step,
          current: path.basename(fromPath),
        }));
      }
      const row = yield* outcomeOf(fromPath);
      yield* moving((step) =>
        row === undefined
          ? { ...step, total: step.total - 1 }
          : row.moved === 1
            ? { ...step, moved: step.moved + 1 }
            : {
                ...step,
                stuck: [...step.stuck, stuckOf(fromPath, row.error ?? "")],
              },
      );
    });

  const drain = Effect.gen(function* () {
    yield* scan.pipe(Effect.orDie);
    const rows = yield* migrationRows.pipe(Effect.orDie);
    const pending = rows.filter((row) => row.moved === 0 && row.error === null);
    const begun = yield* migration.current;
    if (pending.length > 0 || begun.worktrees !== null) {
      // Owed by the import this start made, or resumed from a start
      // that stopped partway.
      yield* migration.update((current) => ({
        planned: true,
        import: current.import ?? { state: "done" },
        worktrees: {
          state: "running",
          moved: rows.filter((row) => row.moved === 1).length,
          total: rows.length,
          current: null,
          stuck: rows.flatMap((row) =>
            row.error === null ? [] : [stuckOf(row.from_path, row.error)],
          ),
        },
      }));
    } else {
      yield* migration.update((current) => ({ ...current, planned: true }));
    }
    const owed = yield* sql<{ project_id: string }>`
      SELECT DISTINCT project_id FROM wt_moves
      WHERE moved = 0 AND error IS NULL`.pipe(Effect.orDie);
    for (const { project_id } of owed) {
      yield* moveProject(project_id, false, report);
    }
    yield* moving((step) => ({
      ...step,
      state: step.stuck.length > 0 ? "stuck" : "done",
      current: null,
    }));
  }).pipe(Effect.withSpan("WtFolder.drain"));

  const retry = Effect.fn("WtFolder.retry")(function* (projectId: string) {
    yield* moveProject(projectId, true);
    return (yield* unmoved).filter((row) => row.projectId === projectId);
  });

  // Through every later move of the folder, a few deep at most.
  const movedTo = Effect.fn("WtFolder.movedTo")(function* (fromPath: string) {
    let at: string | undefined;
    for (let hop = 0; hop < 8; hop++) {
      const [row] = yield* sql<{ to_path: string }>`
        SELECT to_path FROM wt_moves
        WHERE from_path = ${at ?? fromPath} AND moved = 1`.pipe(Effect.orDie);
      if (row === undefined || row.to_path === fromPath) break;
      at = row.to_path;
    }
    return Option.fromNullishOr(at);
  });

  return WtFolder.of({ drain, unmoved, retry, movedTo });
});

export const layer = Layer.effect(WtFolder, make);

// The moves made before anything else runs, for the engine's processes.
export const drained = Layer.effectDiscard(
  Effect.flatMap(Effect.service(WtFolder), (folder) => folder.drain),
);
