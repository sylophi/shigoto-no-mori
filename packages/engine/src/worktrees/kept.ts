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
import { CaptureNotCarried } from "./documents.ts";

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

  // A capture belongs to the worktree, not its old path. It followed (or
  // there was none), stayed because another is kept under `to` (never
  // written over: a re-key back would otherwise put a stale one over the
  // worktree's own), or failed to follow.
  const rekeyCapture = (project: RegisteredProject, from: string, to: string) =>
    Effect.gen(function* () {
      const capture = yield* git.refTip(project.path, dirtyRef(from));
      if (Option.isNone(capture)) return "followed" as const;
      const there = yield* git.refTip(project.path, dirtyRef(to));
      if (Option.isSome(there) && there.value !== capture.value) {
        return "occupied" as const;
      }
      if (Option.isNone(there)) {
        yield* git.updateRef({
          repo: project.path,
          ref: dirtyRef(to),
          commit: capture.value,
          expected: "",
        });
      }
      yield* git.deleteRef(project.path, dirtyRef(from));
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
    // Fails when the capture didn't follow, its rows carried, for the
    // caller to try again or say so: asked again it carries the capture.
    rekey: (
      project: RegisteredProject,
      from: string,
      to: string,
      options: { readonly back?: boolean } = {},
    ) =>
      Effect.andThen(
        rekeyRows(project, from, to),
        Effect.flatMap(rekeyCapture(project, from, to), (carried) =>
          carried === "followed" || (carried === "occupied" && options.back)
            ? Effect.void
            : Effect.fail(new CaptureNotCarried({ from, to, reason: carried })),
        ),
      ),
    forget: (project: RegisteredProject, worktreeId: string) =>
      Effect.andThen(
        forgetRows(project, worktreeId),
        git.deleteRef(project.path, dirtyRef(worktreeId)).pipe(Effect.ignore),
      ),
  };
});

export type KeptArea = Effect.Success<typeof makeKept>;
