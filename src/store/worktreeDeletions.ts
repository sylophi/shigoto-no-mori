// Tracks worktrees the user has committed to deleting but whose
// removal is still in flight (teardown script running, or the actual
// `git worktree remove` mid-call). The sidebar dims and the detail
// page goes read-only while a worktree appears here.
import { useSyncExternalStore } from "react";

export type DeletionPhase = "tearingDown" | "removing";

const state = new Map<string, DeletionPhase>();
const perKeySubs = new Map<string, Set<() => void>>();

function notify(worktreeId: string) {
  const subs = perKeySubs.get(worktreeId);
  if (!subs) return;
  for (const cb of subs) cb();
}

export const worktreeDeletions = {
  set(worktreeId: string, phase: DeletionPhase): void {
    if (state.get(worktreeId) === phase) return;
    state.set(worktreeId, phase);
    notify(worktreeId);
  },
  clear(worktreeId: string): void {
    if (!state.has(worktreeId)) return;
    state.delete(worktreeId);
    notify(worktreeId);
  },
  get(worktreeId: string): DeletionPhase | undefined {
    return state.get(worktreeId);
  },
  subscribe(worktreeId: string, cb: () => void): () => void {
    let subs = perKeySubs.get(worktreeId);
    if (!subs) {
      subs = new Set();
      perKeySubs.set(worktreeId, subs);
    }
    subs.add(cb);
    return () => {
      const bucket = perKeySubs.get(worktreeId);
      if (!bucket) return;
      bucket.delete(cb);
      if (bucket.size === 0) perKeySubs.delete(worktreeId);
    };
  },
};

export function useWorktreeDeletion(
  worktreeId: string,
): DeletionPhase | undefined {
  return useSyncExternalStore(
    (cb) => worktreeDeletions.subscribe(worktreeId, cb),
    () => state.get(worktreeId),
    () => undefined,
  );
}
