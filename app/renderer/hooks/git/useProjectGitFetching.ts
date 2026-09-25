import { useSyncExternalStore } from "react";

// Module-level so every consumer shares one IPC subscription and one
// view of "which projects are currently fetching." Events broadcast
// before any hook mounts are still safe to miss. The renderer treats
// the absence of a fetchActive=true as "not fetching."
const active = new Set<string>();
const listeners = new Set<() => void>();

let subscribed = false;

// Subscribes exactly once across the renderer's lifetime, on first use.
// The subscription is never torn down, so no unsubscribe is kept.
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  window.api.git.onFetchActive(({ projectId, active: isActive }) => {
    if (isActive) active.add(projectId);
    else active.delete(projectId);
    for (const l of listeners) l();
  });
}

export function useProjectGitFetching(projectId: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      ensureSubscribed();
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => active.has(projectId),
    () => false,
  );
}
