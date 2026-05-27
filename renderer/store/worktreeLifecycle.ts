// Tracks the in-flight create-lifecycle phase per worktree so the
// detail page can show a banner (carrying over / setting up /
// provisioning ports) and the carry-over failure toast can fire after
// the IPC has already returned. Main is the source of truth; this
// store only reflects events it broadcasts.
import { useSyncExternalStore } from "react";
import type { CreatePhase } from "@shared/schemas";
import { toast } from "@/lib/toast";
import type { RendererApi } from "@/window";

export type { CreatePhase } from "@shared/schemas";

type WorktreesApi = Pick<
  RendererApi["worktrees"],
  "onLifecyclePhase" | "onCarryOverComplete"
>;

type WarnFn = (title: string, options?: { description?: string }) => unknown;

class WorktreeLifecycleStore {
  private phases = new Map<string, CreatePhase>();
  private subs = new Map<string, Set<() => void>>();
  private unsubscribePhase: (() => void) | null = null;
  private unsubscribeCarryOver: (() => void) | null = null;
  private api: WorktreesApi;
  private warn: WarnFn;

  constructor(api: WorktreesApi, warn: WarnFn) {
    this.api = api;
    this.warn = warn;
  }

  start(): void {
    if (this.unsubscribePhase) return;
    this.unsubscribePhase = this.api.onLifecyclePhase((evt) => {
      this.setPhase(evt.worktreeId, evt.phase === "idle" ? null : evt.phase);
    });
    this.unsubscribeCarryOver = this.api.onCarryOverComplete((evt) => {
      const { applied, failures } = evt.report;
      if (failures.length === 0) return;
      const lines = failures.slice(0, 4).map((f) => `${f.path}: ${f.reason}`);
      const more = failures.length - lines.length;
      this.warn(
        `Carried over ${applied} of ${applied + failures.length} entries`,
        {
          description:
            lines.join("\n") + (more > 0 ? `\n...and ${more} more` : ""),
        },
      );
    });
  }

  dispose(): void {
    this.unsubscribePhase?.();
    this.unsubscribePhase = null;
    this.unsubscribeCarryOver?.();
    this.unsubscribeCarryOver = null;
    this.phases.clear();
    this.subs.clear();
  }

  subscribe(worktreeId: string, cb: () => void): () => void {
    let bucket = this.subs.get(worktreeId);
    if (!bucket) {
      bucket = new Set();
      this.subs.set(worktreeId, bucket);
    }
    bucket.add(cb);
    return () => {
      const b = this.subs.get(worktreeId);
      if (!b) return;
      b.delete(cb);
      if (b.size === 0) this.subs.delete(worktreeId);
    };
  }

  snapshot(worktreeId: string): CreatePhase | null {
    return this.phases.get(worktreeId) ?? null;
  }

  private setPhase(worktreeId: string, phase: CreatePhase | null): void {
    if (phase === null) {
      if (!this.phases.delete(worktreeId)) return;
    } else {
      if (this.phases.get(worktreeId) === phase) return;
      this.phases.set(worktreeId, phase);
    }
    this.notify(worktreeId);
  }

  private notify(worktreeId: string): void {
    const bucket = this.subs.get(worktreeId);
    if (!bucket) return;
    for (const cb of bucket) cb();
  }
}

// `start()` is called by the renderer entry point so subscription
// lifecycle has a single owner. Importing this module just constructs
// the singleton; it does not attach IPC listeners as a side effect.
export const worktreeLifecycle = new WorktreeLifecycleStore(
  window.api.worktrees,
  (title, options) => toast.warning(title, options),
);

export function useWorktreeCreatePhase(worktreeId: string): CreatePhase | null {
  return useSyncExternalStore(
    (cb) => worktreeLifecycle.subscribe(worktreeId, cb),
    () => worktreeLifecycle.snapshot(worktreeId),
    () => null,
  );
}
