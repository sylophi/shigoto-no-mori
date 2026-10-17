// What is under way in the worktrees, as the host marks it: the
// deletes and moves, the creates still working in their checkout, the
// project removals, and whether the quit has begun. The runs refuse to
// start and the busy count reads from here.
import { WorktreeSettingUpError } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import { WorktreeBusyError } from "./documents";

export const makeMarks = Effect.sync(() => {
  // Ref-counted: overlapping deleters can mark the same worktree (a
  // per-worktree delete racing a nuke that lists it too), and the mark
  // must hold until the last one finishes.
  const deletes = new Map<string, number>();
  // Past the engine's "created" document, not yet exited.
  const creates = new Set<string>();
  const projectRemovals = new Set<string>();
  let quitting = false;

  const markDelete = (worktreeId: string) =>
    deletes.set(worktreeId, (deletes.get(worktreeId) ?? 0) + 1);
  const clearDelete = (worktreeId: string) => {
    const count = deletes.get(worktreeId);
    if (count === undefined) return;
    if (count <= 1) deletes.delete(worktreeId);
    else deletes.set(worktreeId, count - 1);
  };

  // Refuses a delete or move of a worktree something is already working
  // in: another delete or move (with the caller's busy message), or its
  // create run, which removing or moving the folder would pull the
  // checkout out from under.
  const assertMutable = Effect.fn("Scripts.assertWorktreeMutable")(function* (
    worktreeId: string,
    busyMessage: string,
  ) {
    if (deletes.has(worktreeId)) {
      return yield* new WorktreeBusyError({ reason: busyMessage });
    }
    if (creates.has(worktreeId)) return yield* new WorktreeSettingUpError();
  });

  // The worktrees marked as being deleted until the scope closes.
  const deleting = Effect.fn("Scripts.deleting")(function* (
    worktreeIds: readonly string[],
  ) {
    yield* Effect.acquireRelease(
      Effect.sync(() => worktreeIds.forEach(markDelete)),
      () => Effect.sync(() => worktreeIds.forEach(clearDelete)),
    );
  });

  // Holds a project's renderer script runs off for the whole removal,
  // since projects.remove doesn't know its worktree ids without a git
  // call.
  const removingProject = Effect.fn("Scripts.removingProject")(function* <
    A,
    E,
    R,
  >(projectId: string, effect: Effect.Effect<A, E, R>) {
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => projectRemovals.add(projectId)),
      () => effect,
      () => Effect.sync(() => projectRemovals.delete(projectId)),
    );
  });

  // Why a run can't start in this worktree now, or null when it can. A
  // run must not land in a worktree mid-delete: the delete stops its
  // scripts once, so one started after would keep a dev server running
  // in a folder being removed.
  const refusal = (worktreeId: string, projectId: string): string | null =>
    quitting
      ? "App is shutting down; refusing to start a new script."
      : deletes.has(worktreeId)
        ? "This worktree is being deleted."
        : projectRemovals.has(projectId)
          ? "This project is being removed."
          : null;

  return {
    assertMutable,
    deleting,
    removingProject,
    refusal,
    markCreate: (worktreeId: string) => void creates.add(worktreeId),
    clearCreate: (worktreeId: string) => void creates.delete(worktreeId),
    refuseNew: Effect.sync(() => {
      quitting = true;
    }),
    deleteIds: (): ReadonlySet<string> => new Set(deletes.keys()),
    removals: () => deletes.size + projectRemovals.size,
    underRemoval: (ids: {
      readonly projectId?: string;
      readonly worktreeId?: string;
    }) =>
      (ids.worktreeId !== undefined && deletes.has(ids.worktreeId)) ||
      (ids.projectId !== undefined && projectRemovals.has(ids.projectId)),
  };
});

export type Marks = Effect.Success<typeof makeMarks>;
