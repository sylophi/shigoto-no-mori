// The one-time move of v2's worktrees into `wt/` that the store's
// `wtFolder` migration owes (migrations/wtFolder.ts). The first start
// looks through the v2 roots of every listed project, terrier's
// included, and records each folder there. Each is then moved as
// `worktrees move` moves one, whose own record keeps two processes
// starting together from both taking it and lets a start finish one a
// crash cut short (worktrees/moving.ts). One that can't be moved keeps
// its folder and records why, for the doctor to report and retry. The
// first start's
// moves are reported to the migration as they go (Migration.ts), and
// a start that resumes them counts the ones made before.
import type { WorktreeMoveStep } from "@shigomori/contracts/schemas/migration";
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Git from "./Git.ts";
import {
  externalVolumeRoot,
  isSameOrInside,
} from "@shigomori/contracts/git/worktreeLayout";
import * as Migration from "./Migration.ts";
import * as Paths from "./Paths.ts";
import * as Registry from "./Registry.ts";
import { working, type Working } from "./processes.ts";
import { worktreeIdFromPath } from "./worktreeLayout.ts";
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
    // The migration's stuck moves tried again, reported as the first
    // start's were: one moved comes off the stuck list, one that still
    // can't move goes back on it with why.
    readonly retryStuck: Effect.Effect<void>;
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
    // The id each moved worktree had, to the one it has now, for a peer
    // or a mirror session that still names it by the old one. A folder
    // back at the old path keeps the id to itself.
    readonly movedIds: Effect.Effect<ReadonlyMap<string, string>>;
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

// What to close before a worktree can move: each program running in
// it, with its pids. None when nothing runs there.
const closeFirst = (inside: ReadonlyArray<Working>) => {
  if (inside.length === 0) return undefined;
  const pids = new Map<string, number[]>();
  for (const { command, pid } of inside) {
    pids.set(command, [...(pids.get(command) ?? []), pid]);
  }
  const named = [...pids].map(
    ([command, of]) => `${command} (${of.join(", ")})`,
  );
  const listed =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return `close ${listed}, which ${inside.length === 1 ? "runs" : "run"} in it`;
};

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

  // Why a move couldn't be made, on its row. A store that refuses even
  // that (busy, or read-only) leaves the row as it was, tried again by
  // the next start.
  const failed = (fromPath: string, error: string) =>
    sql`UPDATE wt_moves SET error = ${error}
      WHERE from_path = ${fromPath} AND moved = 0`.pipe(Effect.ignore);

  // One recorded move, made or failed. A worktree something runs in (a
  // shell, a dev server, an agent) stays, since the move would take its
  // folder from under it. The move's own record keeps a second process
  // starting together from taking it too (worktrees/moving.ts), so no
  // write lock is held across git's move.
  const moveOne = (
    project: Registry.RegisteredProject,
    fromPath: string,
    running: Result.Result<
      ReadonlyArray<Working>,
      { readonly message: string }
    >,
  ) =>
    Effect.gen(function* () {
      const [row] = yield* sql<Row>`
        SELECT from_path, to_path, project_id, error FROM wt_moves
        WHERE from_path = ${fromPath} AND moved = 0`;
      if (row === undefined) return;
      const listed = yield* worktrees.identities(project).pipe(Effect.result);
      if (Result.isFailure(listed)) {
        return yield* failed(fromPath, why(listed.failure));
      }
      // git spells a path with its symlinks resolved.
      const at = (p: string) =>
        Effect.map(fs.realPath(p).pipe(Effect.orElseSucceed(() => p)), (real) =>
          listed.success.find((id) => id.path === p || id.path === real),
        );
      const from = yield* at(row.from_path);
      if (from !== undefined) {
        // Not knowing what runs in it is no leave to move it.
        const busy = Result.isFailure(running)
          ? running.failure.message
          : closeFirst(
              running.success.filter(({ cwd }) =>
                isSameOrInside(cwd, row.from_path),
              ),
            );
        if (busy !== undefined) return yield* failed(fromPath, busy);
      }
      if (from === undefined) {
        // Listed at its wt/ path with no record to say it is this one
        // (git moved it before a crash, under a build that kept none): it
        // stays stuck, never carried by path alone. Listed nowhere, it is
        // a stray folder, which stays where it is, unless another process
        // has made the move meanwhile.
        if ((yield* at(row.to_path)) !== undefined) {
          return yield* failed(
            fromPath,
            "git lists it in wt/ already, moved before a crash; what sm kept under its old id wasn't carried",
          );
        }
        return yield* sql`DELETE FROM wt_moves
          WHERE from_path = ${fromPath} AND moved = 0
          AND NOT EXISTS (SELECT 1 FROM moving WHERE from_path = ${fromPath})`;
      }
      // A move records itself as made (Worktrees.carryMoved).
      const outcome = yield* Effect.result(
        worktrees.move({ project, worktree: from }, row.to_path),
      );
      if (
        Result.isFailure(outcome) &&
        // Another process is making this very move.
        !(
          outcome.failure instanceof Worktrees.WorktreeRefused &&
          outcome.failure.reason === "move-in-progress"
        )
      ) {
        yield* failed(fromPath, why(outcome.failure));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : failed(fromPath, errorMessageOf(Cause.squash(cause))),
      ),
    );

  // rmdir, which takes only an empty folder. Finder's .DS_Store, which
  // a v2 root it was opened in holds when nothing else is left there,
  // counts as nothing.
  const removeEmpty = (dir: string) =>
    Effect.gen(function* () {
      const entries = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      if (entries.length === 1 && entries[0] === ".DS_Store") {
        yield* fs.remove(path.join(dir, ".DS_Store")).pipe(Effect.ignore);
      }
      return yield* spawner.exitCode(ChildProcess.make("rmdir", [dir])).pipe(
        Effect.map((code) => code === 0),
        Effect.orElseSucceed(() => false),
      );
    });

  // The emptied v2 roots of `rows`' moves, and the `worktrees` folder
  // above one.
  const sweepRoots = (rows: ReadonlyArray<{ readonly from_path: string }>) =>
    Effect.gen(function* () {
      const roots = new Set(rows.map((row) => path.dirname(row.from_path)));
      for (const root of roots) {
        const there = yield* fs
          .exists(root)
          .pipe(Effect.orElseSucceed(() => false));
        if (!there || !(yield* removeEmpty(root))) continue;
        const above = path.dirname(root);
        if (path.basename(above) === "worktrees") yield* removeEmpty(above);
      }
    });

  // The project's moves, the failed ones too with `again`. `report`
  // hears each move before and after it is tried.
  const moveProject = (
    projectId: string,
    again: boolean,
    report?: (fromPath: string, tried: boolean) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      // Its moves a crash cut short, before any is tried again.
      yield* worktrees.resumeMoves;
      const project = (yield* registry.listed).find(
        ({ id }) => id === projectId,
      );
      const rows = (yield* sql<Row>`
        SELECT from_path, to_path, project_id, error FROM wt_moves
        WHERE project_id = ${projectId} AND moved = 0`).filter(
        (row) => again || row.error === null,
      );
      if (project === undefined || rows.length === 0) return;
      const running = yield* Effect.result(working(spawner));
      for (const row of rows) {
        yield* report?.(row.from_path, false) ?? Effect.void;
        yield* moveOne(project, row.from_path, running);
        yield* report?.(row.from_path, true) ?? Effect.void;
      }
      yield* git.run(project.path, ["worktree", "repair"]).pipe(Effect.ignore);
      yield* sweepRoots(rows);
    });

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
  // Read before the write transaction, which takes the lock: almost
  // every start has nothing owed.
  const scanOwed = sql`SELECT id FROM wt_move_scan LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
  );
  const scanNow = sql.withTransaction(
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
  const scan = Effect.flatMap(scanOwed, (owed) =>
    owed ? scanNow : Effect.void,
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

  // A step the store's own failure stopped (busy, read-only): stuck with
  // why, for its Retry, rather than a start that can't go on.
  const stopped = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
      yield* Effect.logWarning("The move into wt/ stopped", cause);
      const reason = { name: "", reason: errorMessageOf(Cause.squash(cause)) };
      // A start that owes no migration goes on, and the next one tries
      // again.
      yield* migration.update((current) =>
        current.import === null && current.worktrees === null
          ? { ...current, planned: true }
          : {
              planned: true,
              import: current.import,
              worktrees: {
                ...(current.worktrees ?? Migration.WAITING_MOVE),
                state: "stuck",
                current: null,
                stuck: [...(current.worktrees?.stuck ?? []), reason],
              },
            },
      );
    });

  const drain = Effect.gen(function* () {
    // A move of any worktree a crash cut short, before the migration's
    // own: one of them may be the one cut short.
    yield* worktrees.resumeMoves;
    yield* scan;
    const rows = yield* migrationRows;
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
      WHERE moved = 0 AND error IS NULL`;
    for (const { project_id } of owed) {
      yield* moveProject(project_id, false, report);
    }
    // Those a start that stopped after its moves left.
    yield* sweepRoots(rows);
    yield* moving((step) => ({
      ...step,
      state: step.stuck.length > 0 ? "stuck" : "done",
      current: null,
    }));
  }).pipe(Effect.catchCause(stopped), Effect.withSpan("WtFolder.drain"));

  // The move's step as the store has it now: what another path (the
  // doctor's fix) moved since is counted, and its stuck rows listed.
  const stepNow = (state: WorktreeMoveStep["state"]) =>
    Effect.gen(function* () {
      const rows = yield* migrationRows;
      const stuck = rows.flatMap((row) =>
        row.moved === 0 && row.error !== null
          ? [stuckOf(row.from_path, row.error)]
          : [],
      );
      yield* moving(() => ({
        state: state === "running" || stuck.length === 0 ? state : "stuck",
        moved: rows.filter((row) => row.moved === 1).length,
        total: rows.length,
        current: null,
        stuck: state === "running" ? [] : stuck,
      }));
    });

  // One retry at a time: every window on the page has its own Retry.
  const retrying = yield* Semaphore.make(1);
  const retryStuck = retrying
    .withPermit(
      Effect.gen(function* () {
        // A scan the store's failure stopped is made now, and the moves
        // it left untried are tried with the stuck ones.
        yield* scan;
        const stuck = (yield* migrationRows).filter((row) => row.moved === 0);
        // Nothing to move reads the store and ends, without a running
        // step that would call every window back to the page.
        if (stuck.length > 0) yield* stepNow("running");
        for (const projectId of new Set(stuck.map((row) => row.project_id))) {
          yield* moveProject(projectId, true, report);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The retry of the move into wt/ failed", cause),
        ),
        // A retry that failed still ends its step, read from the store.
        Effect.ensuring(stepNow("done").pipe(Effect.catchCause(stopped))),
      ),
    )
    .pipe(Effect.withSpan("WtFolder.retryStuck"));

  const retry = Effect.fn("WtFolder.retry")(function* (projectId: string) {
    yield* moveProject(projectId, true).pipe(Effect.orDie);
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

  const movedIds = Effect.gen(function* () {
    const rows = yield* sql<{ from_path: string; to_path: string }>`
      SELECT from_path, to_path FROM wt_moves WHERE moved = 1`.pipe(
      Effect.orDie,
    );
    const next = new Map(rows.map((row) => [row.from_path, row.to_path]));
    const ids = new Map<string, string>();
    for (const { from_path } of rows) {
      const taken = yield* fs
        .exists(from_path)
        .pipe(Effect.orElseSucceed(() => true));
      if (taken) continue;
      let at = from_path;
      for (let hop = 0; hop < 8; hop++) {
        const to = next.get(at);
        if (to === undefined || to === from_path) break;
        at = to;
      }
      if (at !== from_path) {
        ids.set(worktreeIdFromPath(from_path), worktreeIdFromPath(at));
      }
    }
    return ids as ReadonlyMap<string, string>;
  }).pipe(Effect.withSpan("WtFolder.movedIds"));

  return WtFolder.of({
    drain,
    unmoved,
    retryStuck,
    retry,
    movedTo,
    movedIds,
  });
});

export const layer = Layer.effect(WtFolder, make);

// The moves made before anything else runs, for the engine's processes.
export const drained = Layer.effectDiscard(
  Effect.flatMap(Effect.service(WtFolder), (folder) => folder.drain),
);
