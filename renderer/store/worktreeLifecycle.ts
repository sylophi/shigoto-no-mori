// Tracks the in-flight create-lifecycle phase per worktree so the
// detail page can show a banner (carrying over / setting up /
// provisioning ports) and the carry-over failure toast can fire after
// the IPC has already returned. Main is the source of truth; this
// store only reflects events it broadcasts.
import { useSyncExternalStore } from "react";
import type { CreatePhase } from "@shared/schemas";
import { singletonInit } from "@/lib/singletonInit";
import { toast } from "@/lib/toast";

export type { CreatePhase } from "@shared/schemas";

const phases = new Map<string, CreatePhase>();
const subs = new Map<string, Set<() => void>>();

function notify(worktreeId: string): void {
  const bucket = subs.get(worktreeId);
  if (!bucket) return;
  for (const cb of bucket) cb();
}

function setPhase(worktreeId: string, phase: CreatePhase | null): void {
  if (phase === null) {
    if (!phases.delete(worktreeId)) return;
  } else {
    if (phases.get(worktreeId) === phase) return;
    phases.set(worktreeId, phase);
  }
  notify(worktreeId);
}

export const ensureLifecycleSubscription = singletonInit(() => {
  window.api.worktrees.onLifecyclePhase((evt) => {
    setPhase(evt.worktreeId, evt.phase === "idle" ? null : evt.phase);
  });
  window.api.worktrees.onCarryOverComplete((evt) => {
    const { applied, failures } = evt.report;
    if (failures.length === 0) return;
    const lines = failures.slice(0, 4).map((f) => `${f.path}: ${f.reason}`);
    const more = failures.length - lines.length;
    toast.warning(
      `Carried over ${applied} of ${applied + failures.length} entries`,
      {
        description:
          lines.join("\n") + (more > 0 ? `\n...and ${more} more` : ""),
      },
    );
  });
});

function subscribe(worktreeId: string, cb: () => void): () => void {
  let bucket = subs.get(worktreeId);
  if (!bucket) {
    bucket = new Set();
    subs.set(worktreeId, bucket);
  }
  bucket.add(cb);
  return () => {
    const b = subs.get(worktreeId);
    if (!b) return;
    b.delete(cb);
    if (b.size === 0) subs.delete(worktreeId);
  };
}

export function useWorktreeCreatePhase(worktreeId: string): CreatePhase | null {
  return useSyncExternalStore(
    (cb) => subscribe(worktreeId, cb),
    () => phases.get(worktreeId) ?? null,
    () => null,
  );
}
