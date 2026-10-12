// React bindings over the per-device script runs (scriptRuns.ts). The
// hooks resolve the device from the host scope (this machine's with no
// provider mounted, a peer's under one), so the same row, console and
// detail-page code shows and drives runs on whichever device the
// surrounding subtree names.
import { useAtomValue } from "@effect/atom-react";
import type {
  ScriptActivityKind,
  ScriptRunState,
} from "@shigomori/ui/lib/scriptRun.ts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import type { RunningScript } from "@shigomori/contracts/schemas";
import { useDeviceRunningScripts } from "@/hooks/live/useLiveActivity";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { useHasLocalHost } from "@/lib/localHost";
import type { ScriptKey } from "@/store/scriptSlot";
import { useApi } from "@/lib/runtime/pageApi";
import {
  activityOf,
  EMPTY_STATE,
  type ScriptRuns,
  scriptRunsAtom,
} from "./scriptRuns";

// A device's runs, kept current if they start over (the account left).
function useDeviceScriptRuns(deviceId: string): ScriptRuns {
  const result = useAtomValue(scriptRunsAtom(deviceId));
  if (AsyncResult.isSuccess(result)) return result.value;
  throw AsyncResult.isFailure(result)
    ? Cause.squash(result.cause)
    : new Error("a device's script runs answer when read");
}

// The scoped device's runs.
export function useScriptRuns(): ScriptRuns {
  return useDeviceScriptRuns(useHostScope().deviceId);
}

export function useScriptRunState(key: ScriptKey): ScriptRunState {
  const runs = useScriptRuns();
  return useAtomValue(
    runs.state,
    (state) => state.states.get(key) ?? EMPTY_STATE,
  );
}

// The sidebar's activity glyph. Takes its device explicitly rather than
// reading the scope: the rows render outside any provider, and a peer
// row names the device it belongs to. A run this window holds says
// most; one held elsewhere (another window, another device) shows off
// the device's running scripts.
export function useWorktreeScriptActivity(
  worktreeId: string,
  device?: string,
): ScriptActivityKind | null {
  const api = useApi();
  const localDeviceId = api.deviceId;
  const deviceId = device ?? localDeviceId;
  const hasLocalHost = useHasLocalHost();
  const runs = useDeviceScriptRuns(deviceId);
  const held = useAtomValue(runs.state, (state) =>
    activityOf(state, worktreeId),
  );
  const local = deviceId === localDeviceId;
  const peerApi = useRemoteDeviceApi(local ? undefined : deviceId);
  const listed = useDeviceRunningScripts(
    deviceId,
    local ? (hasLocalHost ? api : undefined) : peerApi,
  );
  if (held !== null && held !== "failed") return held;
  return listedActivity(listed ?? [], worktreeId) ?? held;
}

// The busiest of a worktree's listed runs, ranked as the runs rank
// their own: a teardown, then a setup, then a package script.
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
