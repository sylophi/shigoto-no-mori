// What is under way in the worktrees, as the host marks it: the
// deletes and moves, the creates still working in their checkout, the
// project removals, and whether the quit has begun. The runs refuse to
// start and the busy count reads from here.
import { WorktreeSettingUpError } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import { WorktreeBusyError } from "./documents";

// What a worktree's mark is for: a removal, or a move (a rename, a
// relocate, a data-folder move) that keeps it under another path.
export type MarkKind = "remove" | "move";

export const makeMarks = Effect.sync(() => {
  // Ref-counted per kind: overlapping deleters can mark the same worktree
  // (a per-worktree delete racing a nuke that lists it too), and the
  // mark must hold until the last one finishes.
  const deletes = new Map<string, Record<MarkKind, number>>();
  // Past the engine's "created" document, not yet exited.
  const creates = new Set<string>();
  const projectRemovals = new Set<string>();
  let quitting = false;

  const markDelete = (worktreeId: string, kind: MarkKind) => {
    const counts = deletes.get(worktreeId) ?? { remove: 0, move: 0 };
    counts[kind] += 1;
    deletes.set(worktreeId, counts);
  };
  const clearDelete = (worktreeId: string, kind: MarkKind) => {
    const counts = deletes.get(worktreeId);
    if (counts === undefined || counts[kind] === 0) return;
    counts[kind] -= 1;
    if (counts.remove + counts.move === 0) deletes.delete(worktreeId);
  };
  // A worktree both removed and moved reads as removed.
  const kindOf = (worktreeId: string): MarkKind | undefined => {
    const counts = deletes.get(worktreeId);
    if (counts === undefined) return undefined;
    return counts.remove > 0 ? "remove" : "move";
  };
  const counted = (kind: MarkKind) =>
    [...deletes.keys()].filter((id) => kindOf(id) === kind).length;

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

  const deleting = Effect.fn("Scripts.deleting")(function* (
    worktreeIds: readonly string[],
    kind: MarkKind,
  ) {
    yield* Effect.acquireRelease(
      Effect.sync(() => worktreeIds.forEach((id) => markDelete(id, kind))),
      () =>
        Effect.sync(() => worktreeIds.forEach((id) => clearDelete(id, kind))),
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
      : kindOf(worktreeId) === "remove"
        ? "This worktree is being deleted."
        : kindOf(worktreeId) === "move"
          ? "This worktree is being moved."
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
    removals: () => counted("remove") + projectRemovals.size,
    moves: () => counted("move"),
    underRemoval: (ids: {
      readonly projectId?: string;
      readonly worktreeId?: string;
    }) =>
      (ids.worktreeId !== undefined && deletes.has(ids.worktreeId)) ||
      (ids.projectId !== undefined && projectRemovals.has(ids.projectId)),
  };
});

export type Marks = Effect.Success<typeof makeMarks>;
