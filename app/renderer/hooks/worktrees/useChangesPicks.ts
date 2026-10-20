import { useSyncExternalStore } from "react";
import {
  ALL_TICKED,
  type ChangesPicks,
} from "@shigomori/ui/views/diff/changesPicks.ts";

// What the changes page has ticked (changesPicks), held for the session
// per worktree, so leaving the page and coming back keeps it. A reload
// starts over at everything.
const held = new Map<string, ChangesPicks>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// By device too, as the commit draft is (lib/commitDraft.ts).
const keyOf = (deviceId: string, projectId: string, worktreeId: string) =>
  `${deviceId}.${projectId}.${worktreeId}`;

export function useChangesPicks(
  deviceId: string,
  projectId: string,
  worktreeId: string,
): ChangesPicks {
  const key = keyOf(deviceId, projectId, worktreeId);
  return useSyncExternalStore(subscribe, () => held.get(key) ?? ALL_TICKED);
}

// From what is held rather than what a render saw, so two ticks before
// a re-render both land.
export function updatePicks(
  deviceId: string,
  projectId: string,
  worktreeId: string,
  change: (current: ChangesPicks) => ChangesPicks,
): void {
  const key = keyOf(deviceId, projectId, worktreeId);
  const current = held.get(key) ?? ALL_TICKED;
  const next = change(current);
  if (next === current) return;
  if (next.size === 0) held.delete(key);
  else held.set(key, next);
  for (const listener of listeners) listener();
}

export function forgetPicks(
  deviceId: string,
  projectId: string,
  worktreeId: string,
): void {
  updatePicks(deviceId, projectId, worktreeId, () => ALL_TICKED);
}
