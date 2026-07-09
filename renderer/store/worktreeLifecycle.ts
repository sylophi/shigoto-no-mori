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

type NotifyFn = (title: string, options?: { description?: string }) => unknown;

interface StartDeps {
  // Fired when main auto-removed manual carry-over entries because
  // .worktreeinclude now covers them, so caches over project.json can be
  // invalidated.
  onCarryOverReconciled?: (projectId: string) => void;
}

function clippedLines(lines: string[], max: number): string {
  const shown = lines.slice(0, max);
  const more = lines.length - shown.length;
  return shown.join("\n") + (more > 0 ? `\n...and ${more} more` : "");
}

class WorktreeLifecycleStore {
  private phases = new Map<string, CreatePhase>();
  private subs = new Map<string, Set<() => void>>();
  private unsubscribePhase: (() => void) | null = null;
  private unsubscribeCarryOver: (() => void) | null = null;
  private api: WorktreesApi;
  private warn: NotifyFn;
  private info: NotifyFn;
  private onCarryOverReconciled: ((projectId: string) => void) | null = null;

  constructor(api: WorktreesApi, warn: NotifyFn, info: NotifyFn) {
    this.api = api;
    this.warn = warn;
    this.info = info;
  }

  start(deps?: StartDeps): void {
    if (this.unsubscribePhase) return;
    this.onCarryOverReconciled = deps?.onCarryOverReconciled ?? null;
    this.unsubscribePhase = this.api.onLifecyclePhase((evt) => {
      this.setPhase(evt.worktreeId, evt.phase === "idle" ? null : evt.phase);
    });
    this.unsubscribeCarryOver = this.api.onCarryOverComplete((evt) => {
      const removed = evt.removedCarryOverPaths ?? [];
      if (removed.length > 0) {
        this.onCarryOverReconciled?.(evt.projectId);
        this.info(
          `.worktreeinclude replaced ${removed.length} carry-over ${
            removed.length === 1 ? "entry" : "entries"
          }`,
          {
            description:
              "The repo's .worktreeinclude file now covers these paths, so " +
              "their manual carry-over entries were removed:\n" +
              clippedLines(removed, 4),
          },
        );
      }
      const { applied, failures } = evt.report;
      const includeFailures = evt.report.includeFailures ?? [];
      if (includeFailures.length > 0) {
        this.warn("Couldn't resolve .worktreeinclude", {
          description: clippedLines(
            includeFailures.map((f) => f.reason),
            4,
          ),
        });
      }
      if (failures.length === 0) return;
      this.warn(
        `Carried over ${applied} of ${applied + failures.length} entries`,
        {
          description: clippedLines(
            failures.map((f) => `${f.path}: ${f.reason}`),
            4,
          ),
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
  (title, options) => toast.info(title, options),
);

export function useWorktreeCreatePhase(worktreeId: string): CreatePhase | null {
  return useSyncExternalStore(
    (cb) => worktreeLifecycle.subscribe(worktreeId, cb),
    () => worktreeLifecycle.snapshot(worktreeId),
    () => null,
  );
}
