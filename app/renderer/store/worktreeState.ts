// What the window keeps about each worktree outside React: its commit
// draft, its pull request drafts, the changes page's picks, its terminal
// drawer and the file its Files page last showed. Every store made here
// is forgotten once the worktree's id is gone, and one that `moves`
// follows the worktree to its new id (useWorktreeMutations).
import { useSyncExternalStore } from "react";
import { readStoredJson, removeStored, writeStored } from "@/lib/localStorage";

// By device too: the ids can be paths' (a terrier project's, every
// worktree's), so two devices with the same layout share them, and a
// worktree removed on one keeps the other's state.
export interface WorktreeRef {
  readonly deviceId: string;
  readonly projectId: string;
  readonly worktreeId: string;
}

export const worktreeKey = ({
  deviceId,
  projectId,
  worktreeId,
}: WorktreeRef): string => `${deviceId}\n${projectId}\n${worktreeId}`;

export interface WorktreeStore<T> {
  get: (ref: WorktreeRef) => T;
  // From the value as it is now rather than what a render saw, so two
  // changes before a re-render both land.
  update: (ref: WorktreeRef, change: (current: T) => T) => void;
  forget: (ref: WorktreeRef) => void;
  subscribe: (listener: () => void) => () => void;
}

const stores: {
  forget: (ref: WorktreeRef) => void;
  move: ((from: WorktreeRef, to: WorktreeRef) => void) | null;
}[] = [];

export function createWorktreeStore<T>({
  empty,
  persist,
  moves,
}: {
  // What a worktree holding nothing reads. Set back to it, a persisted
  // value leaves storage.
  empty: T;
  // Kept across launches. A store registers as its module loads, so a
  // persisted one has to load with the app rather than a lazy page, or
  // a worktree removed before then keeps it.
  persist?: {
    key: (ref: WorktreeRef) => string;
    parse: (stored: Record<string, unknown>) => T;
  };
  moves: boolean;
}): WorktreeStore<T> {
  const values = new Map<string, T>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const get = (ref: WorktreeRef): T => {
    const key = worktreeKey(ref);
    const value = values.get(key);
    if (value !== undefined || !persist) return value ?? empty;
    // Kept once read, so every render reads the same value.
    const stored = persist.parse(readStoredJson(persist.key(ref), {}));
    values.set(key, stored);
    return stored;
  };

  const set = (ref: WorktreeRef, value: T) => {
    values.set(worktreeKey(ref), value);
    if (persist) {
      const key = persist.key(ref);
      if (value === empty) removeStored(key);
      else writeStored(key, JSON.stringify(value));
    }
    notify();
  };

  const forget = (ref: WorktreeRef) => {
    values.delete(worktreeKey(ref));
    if (persist) removeStored(persist.key(ref));
    notify();
  };

  stores.push({
    forget,
    move: moves
      ? (from, to) => {
          const value = get(from);
          forget(from);
          if (value !== empty) set(to, value);
        }
      : null,
  });

  return {
    get,
    update(ref, change) {
      const current = get(ref);
      const next = change(current);
      if (next !== current) set(ref, next);
    },
    forget,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useWorktreeStore<T>(
  store: WorktreeStore<T>,
  ref: WorktreeRef,
): T {
  const read = () => store.get(ref);
  return useSyncExternalStore(store.subscribe, read, read);
}

export function forgetWorktreeStores(ref: WorktreeRef): void {
  for (const store of stores) store.forget(ref);
}

// The stores that move take their value along. The rest are left for
// the old id's forget.
export function moveWorktreeStores(from: WorktreeRef, to: WorktreeRef): void {
  for (const store of stores) store.move?.(from, to);
}
