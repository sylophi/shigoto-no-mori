// React bindings over the per-device script run stores. The hooks
// resolve the store from the host scope (this machine's with no
// provider mounted, a peer's under one), so the same row, console and
// detail-page code shows and drives runs on whichever device the
// surrounding subtree names.
import type {
  ScriptActivityKind,
  ScriptRunState,
} from "@shigomori/ui/lib/scriptRun.ts";
import { useSyncExternalStore } from "react";
import type { RunningScript } from "@shigomori/contracts/schemas";
import { useDeviceRunningScripts } from "@/hooks/live/useLiveActivity";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import {
  EMPTY_STATE,
  type ScriptKey,
  type ScriptRunsStore,
  scriptRunsFor,
} from "@/store/scriptRuns";

// The scoped device's store.
export function useScriptRuns(): ScriptRunsStore {
  return scriptRunsFor(useHostScope().deviceId);
}

export function useScriptRunState(key: ScriptKey): ScriptRunState {
  return useDeviceScriptRunState(useHostScope().deviceId, key);
}

// The same for a named device, for a list that spans devices outside
// any scope (the Live page).
function useDeviceScriptRunState(
  deviceId: string,
  key: ScriptKey,
): ScriptRunState {
  const store = scriptRunsFor(deviceId);
  return useSyncExternalStore(
    (cb) => store.subscribe(key, cb),
    () => store.snapshot(key),
    () => EMPTY_STATE,
  );
}

// The sidebar's activity glyph. Takes its device explicitly rather than
// reading the scope: the rows render outside any provider, and a peer
// row names the device it belongs to. A run this window holds says
// most; one held elsewhere (another window, another device) shows off
// the device's running scripts.
export function useWorktreeScriptActivity(
  worktreeId: string,
  deviceId: string = localDeviceId,
): ScriptActivityKind | null {
  const store = scriptRunsFor(deviceId);
  const held = useSyncExternalStore(
    (cb) => store.subscribeWorktree(worktreeId, cb),
    () => store.getActivityKind(worktreeId),
    () => null,
  );
  const local = deviceId === localDeviceId;
  const peerApi = useRemoteDeviceApi(local ? undefined : deviceId);
  const listed = useDeviceRunningScripts(
    deviceId,
    local ? (hasLocalHost ? window.api : undefined) : peerApi,
  );
  if (held !== null && held !== "failed") return held;
  return listedActivity(listed ?? [], worktreeId) ?? held;
}

// The busiest of a worktree's listed runs, ranked as the store ranks
// its own: a teardown, then a setup, then a package script.
function listedActivity(
  runs: readonly RunningScript[],
  worktreeId: string,
): ScriptActivityKind | null {
  let kind: ScriptActivityKind | null = null;
  for (const { worktreeId: id, slot } of runs) {
    if (id !== worktreeId) continue;
    if (
      slot.kind === "teardown" ||
      (slot.kind === "portPool" && slot.phase === "release")
    ) {
      return "teardown";
    }
    if (slot.kind === "setup" || slot.kind === "portPool") kind = "setup";
    else if (kind === null) kind = "package";
  }
  return kind;
}
