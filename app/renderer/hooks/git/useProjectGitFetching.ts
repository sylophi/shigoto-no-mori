import { useSyncExternalStore } from "react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";
import { onAccountLeft, onSessionLanded } from "@/lib/remote/remoteDeviceSync";

// Which projects are fetching refs right now, on which device: fed by
// every device's git:fetchActive broadcast (lib/hostWatch.ts), read by
// the worktree page under that device's scope. Project ids are path
// hashes that can collide across the owner's machines, so an entry is
// keyed by device and project. Events broadcast before any reader
// mounts are still safe to miss: the absence of a fetchActive=true
// reads as "not fetching."
const active = new Set<string>();
const listeners = new Set<() => void>();

const keyOf = (deviceId: string, projectId: string) =>
  `${deviceId}\n${projectId}`;

function forget(match: (key: string) => boolean): void {
  let changed = false;
  for (const key of active) {
    if (!match(key)) continue;
    active.delete(key);
    changed = true;
  }
  if (changed) for (const l of listeners) l();
}

export function noteGitFetchActive(
  deviceId: string,
  projectId: string,
  isActive: boolean,
): void {
  const key = keyOf(deviceId, projectId);
  if (isActive === active.has(key)) return;
  if (isActive) active.add(key);
  else active.delete(key);
  for (const l of listeners) l();
}

// A peer's fetch that ended while its session was down never says so,
// and neither does one on a device of an account that is gone.
onSessionLanded((deviceId) => {
  forget((key) => key.startsWith(`${deviceId}\n`));
});
onAccountLeft(() => {
  forget((key) => !key.startsWith(`${localDeviceId}\n`));
});

export function useProjectGitFetching(projectId: string): boolean {
  const { deviceId } = useHostScope();
  const key = keyOf(deviceId, projectId);
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => active.has(key),
    () => false,
  );
}
