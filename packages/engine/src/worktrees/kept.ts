// What the store keeps under a worktree's id (marks, the shelf, agent
// sessions, its data) and its pending dirty capture: carried to another
// id, or forgotten. What clones proved about the old id goes either way.
// The rows go in one transaction, which a caller may widen to commit
// them with its own; the capture's ref follows, since git isn't in the
// transaction, and a later call finishes it.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as CloneCheckout from "../CloneCheckout.ts";
import { dirtyRef } from "../Dirty.ts";
import * as Git from "../Git.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import * as WorktreeData from "../WorktreeData.ts";

export const makeKept = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const git = yield* Git.Git;
  const registry = yield* Registry.Registry;
  const data = yield* WorktreeData.WorktreeData;
  const cloneCheckout = yield* CloneCheckout.CloneCheckout;

  const rekeyRows = (project: RegisteredProject, from: string, to: string) =>
    sql
      .withTransaction(
        Effect.all([
          registry.moveWorktree(from, to),
          data.move(project.id, from, to),
          cloneCheckout.forget(from),
        ]),
      )
      .pipe(Effect.orDie);

  // A capture belongs to the worktree, not its old path. Whether it
  // followed (or there was none).
  const rekeyCapture = (project: RegisteredProject, from: string, to: string) =>
    Effect.gen(function* () {
      const capture = yield* git.refTip(project.path, dirtyRef(from));
      if (Option.isNone(capture)) return true;
      yield* git.updateRef({
        repo: project.path,
        ref: dirtyRef(to),
        commit: capture.value,
      });
      yield* git.deleteRef(project.path, dirtyRef(from));
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning(
            "A dirty capture's ref didn't follow its move",
            cause,
          ),
          false,
        ),
      ),
    );

  const forgetRows = (project: RegisteredProject, worktreeId: string) =>
    sql
      .withTransaction(
        Effect.all([
          registry.forgetWorktree(worktreeId),
          data.forget(project.id, worktreeId),
          cloneCheckout.forget(worktreeId),
        ]),
      )
      .pipe(Effect.orDie);

  return {
    rekeyRows,
    rekeyCapture,
    forgetRows,
    rekey: (project: RegisteredProject, from: string, to: string) =>
      Effect.andThen(
        rekeyRows(project, from, to),
        rekeyCapture(project, from, to),
      ),
    forget: (project: RegisteredProject, worktreeId: string) =>
      Effect.andThen(
        forgetRows(project, worktreeId),
        git.deleteRef(project.path, dirtyRef(worktreeId)).pipe(Effect.ignore),
      ),
  };
});

export type KeptArea = Effect.Success<typeof makeKept>;
