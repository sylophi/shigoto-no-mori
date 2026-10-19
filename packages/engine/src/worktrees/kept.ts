// What the store keeps under a worktree's id (marks, the shelf, agent
// sessions, its data), its pending dirty capture and its scripts' last
// output (scriptOutput.ts): carried to another id, or forgotten. What clones proved about the old id goes either way.
// The rows go in one transaction, which a caller may widen to commit
// them with its own; the capture's ref follows, since git isn't in the
// transaction, and a later call finishes it. A re-key whose checkout
// moved records the move in `wt_moves` in the same transaction, which
// is where anything kept outside the store under the old id (the host's
// mirrors) learns of it, whoever re-keyed it (WtFolder.movedIds).
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as CloneCheckout from "../CloneCheckout.ts";
import { dirtyRef } from "../Dirty.ts";
import * as Git from "../Git.ts";
import * as Paths from "../Paths.ts";
import { scriptOutputDir } from "../scriptOutput.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import * as WorktreeData from "../WorktreeData.ts";
import { CaptureNotCarried } from "./documents.ts";

// Where a re-keyed checkout was and is now.
export type Moved = { readonly fromPath: string; readonly toPath: string };

export const makeKept = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const git = yield* Git.Git;
  const registry = yield* Registry.Registry;
  const data = yield* WorktreeData.WorktreeData;
  const cloneCheckout = yield* CloneCheckout.CloneCheckout;
  const fs = yield* FileSystem.FileSystem;
  const { dataDir } = yield* Paths.Paths;

  // A recorded move from a path is the folder that last left it: a
  // folder made at a path, or moved there, ends the record of whatever
  // left it before (`claimed`). An earlier move into the path, of the
  // folder that left it, is pointed past it first, so its chain still
  // ends where that folder is.
  const claimed = (paths: ReadonlyArray<string>) =>
    Effect.andThen(
      sql`UPDATE wt_moves AS r SET to_path = (
          SELECT c.to_path FROM wt_moves AS c
          WHERE c.from_path = r.to_path AND c.moved = 1 AND c.rowid > r.rowid)
        WHERE r.moved = 1 AND r.to_path IN ${sql.in(paths)} AND EXISTS (
          SELECT 1 FROM wt_moves AS c
          WHERE c.from_path = r.to_path AND c.moved = 1 AND c.rowid > r.rowid)`,
      sql`DELETE FROM wt_moves WHERE moved = 1 AND from_path IN ${sql.in(paths)}`,
    );

  // Written anew, so the rowid orders the moves (WtFolder's placed).
  const recordMove = (project: RegisteredProject, moved: Moved) =>
    Effect.all([
      claimed([moved.fromPath, moved.toPath]),
      sql`DELETE FROM wt_moves WHERE from_path = ${moved.fromPath}`,
      sql`INSERT INTO wt_moves ${sql.insert({
        from_path: moved.fromPath,
        to_path: moved.toPath,
        project_id: project.id,
        moved: 1,
      })}`,
    ]);

  const rekeyRows = (
    project: RegisteredProject,
    from: string,
    to: string,
    moved?: Moved,
  ) =>
    sql
      .withTransaction(
        Effect.all([
          registry.moveWorktree(from, to),
          data.move(project.id, from, to),
          cloneCheckout.forget(from),
          moved === undefined ? Effect.void : recordMove(project, moved),
        ]),
      )
      .pipe(
        Effect.orDie,
        // The scripts' last output follows, best-effort: it is a log.
        Effect.andThen(
          fs
            .rename(
              scriptOutputDir(dataDir, from),
              scriptOutputDir(dataDir, to),
            )
            .pipe(Effect.ignore),
        ),
      );

  // A capture belongs to the worktree, not its old path. It followed (or
  // there was none to carry), stayed because another is kept under `to`
  // (never written over: a re-key back would otherwise put a stale one
  // over the worktree's own), stayed because it isn't the one `expect`
  // names by its commit (null: none), or failed to follow.
  const rekeyCapture = (
    project: RegisteredProject,
    from: string,
    to: string,
    expect?: string | null,
  ) =>
    Effect.gen(function* () {
      const capture = yield* git.readRef(project.path, dirtyRef(from));
      if (expect !== undefined && Option.getOrNull(capture) !== expect) {
        return "changed" as const;
      }
      if (Option.isNone(capture)) return "followed" as const;
      const there = yield* git.readRef(project.path, dirtyRef(to));
      if (Option.isSome(there) && there.value !== capture.value) {
        return "occupied" as const;
      }
      if (Option.isNone(there)) {
        yield* git.updateRef({
          repo: project.path,
          ref: dirtyRef(to),
          commit: capture.value,
          expected: Git.ABSENT_REF,
        });
      }
      yield* git.deleteRef(project.path, dirtyRef(from), capture.value);
      return "followed" as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning(
            "A dirty capture's ref didn't follow its move",
            cause,
          ),
          "failed" as const,
        ),
      ),
    );

  const forgetRows = (
    project: RegisteredProject,
    worktreeId: string,
    madeAt: ReadonlyArray<string> = [],
  ) =>
    sql
      .withTransaction(
        Effect.all([
          registry.forgetWorktree(worktreeId),
          data.forget(project.id, worktreeId),
          cloneCheckout.forget(worktreeId),
          madeAt.length === 0 ? Effect.void : claimed(madeAt),
        ]),
      )
      .pipe(
        Effect.orDie,
        Effect.andThen(
          fs
            .remove(scriptOutputDir(dataDir, worktreeId), {
              recursive: true,
              force: true,
            })
            .pipe(Effect.ignore),
        ),
      );

  // Whether anything is kept under `worktreeId`: its marks, sessions,
  // shelf or data rows, or a dirty capture, read strictly.
  const keptUnder = Effect.fn("Worktrees.keptUnder")(function* (
    project: RegisteredProject,
    worktreeId: string,
  ) {
    const rows = Object.values(yield* registry.keptIds).some((ids) =>
      ids.has(worktreeId),
    );
    const described = (yield* data.kept).some(
      (row) => row.projectId === project.id && row.worktreeId === worktreeId,
    );
    const capture = yield* git.readRef(project.path, dirtyRef(worktreeId));
    return rows || described || Option.isSome(capture);
  });

  return {
    keptUnder,
    rekeyRows,
    rekeyCapture,
    forgetRows,
    // Fails when the capture didn't follow, its rows carried, for the
    // caller to try again or say so: asked again it carries the capture.
    // A re-key `back` (an undo) leaves a capture that changed or one kept
    // under `to` where it is, and succeeds.
    rekey: (
      project: RegisteredProject,
      from: string,
      to: string,
      options: {
        readonly expect?: string | null;
        readonly back?: boolean;
        readonly moved?: Moved;
      } = {},
    ) =>
      Effect.andThen(
        rekeyRows(project, from, to, options.moved),
        Effect.flatMap(
          rekeyCapture(project, from, to, options.expect),
          (carried) =>
            carried === "followed" ||
            (options.back === true && carried !== "failed")
              ? Effect.void
              : Effect.fail(
                  new CaptureNotCarried({ from, to, reason: carried }),
                ),
        ),
      ),
    // `madeAt`, for a checkout just made there (its path, as asked and as
    // git spells it), ends the record of the folder that left it.
    forget: (
      project: RegisteredProject,
      worktreeId: string,
      madeAt: ReadonlyArray<string> = [],
    ) =>
      Effect.andThen(
        forgetRows(project, worktreeId, madeAt),
        git.deleteRef(project.path, dirtyRef(worktreeId)).pipe(Effect.ignore),
      ),
  };
});

export type KeptArea = Effect.Success<typeof makeKept>;
