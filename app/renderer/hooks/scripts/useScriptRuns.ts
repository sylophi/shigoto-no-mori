// React bindings over the per-device script run stores. The hooks
// resolve the store from the host scope (this machine's with no
// provider mounted, a peer's under one), so the same row, console and
// detail-page code shows and drives runs on whichever device the
// surrounding subtree names.
import { useSyncExternalStore } from "react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";
import {
  EMPTY_STATE,
  type ScriptActivityKind,
  type ScriptKey,
  type ScriptRunState,
  type ScriptRunsStore,
  scriptRunsFor,
} from "@/store/scriptRuns";

// The scoped device's store.
export function useScriptRuns(): ScriptRunsStore {
  return scriptRunsFor(useHostScope().deviceId);
}

export function useScriptRunState(key: ScriptKey): ScriptRunState {
  const store = useScriptRuns();
  return useSyncExternalStore(
    (cb) => store.subscribe(key, cb),
    () => store.snapshot(key),
    () => EMPTY_STATE,
  );
}

// The sidebar's activity glyph. Takes its device explicitly rather than
// reading the scope: the rows render outside any provider, and a peer
// row names the device it belongs to.
export function useWorktreeScriptActivity(
  worktreeId: string,
  deviceId: string = localDeviceId,
): ScriptActivityKind | null {
  const store = scriptRunsFor(deviceId);
  return useSyncExternalStore(
    (cb) => store.subscribeWorktree(worktreeId, cb),
    () => store.getActivityKind(worktreeId),
    () => null,
  );
}
