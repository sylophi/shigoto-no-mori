import { useSyncExternalStore } from "react";
import { singletonInit } from "@/lib/singletonInit";

// Module-level so every consumer shares one IPC subscription and one
// view of "which projects are currently fetching." Events broadcast
// before any hook mounts are still safe to miss -- the renderer treats
// the absence of a fetchActive=true as "not fetching."
const active = new Set<string>();
const listeners = new Set<() => void>();

const ensureSubscribed = singletonInit(() => {
  window.api.git.onFetchActive(({ projectId, active: isActive }) => {
    if (isActive) active.add(projectId);
    else active.delete(projectId);
    for (const l of listeners) l();
  });
});

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
