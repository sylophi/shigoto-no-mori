import { callOf } from "@shigomori/contracts/contract";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import * as Atom from "effect/reactivity/Atom";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useApi } from "@/lib/runtime/pageApi";
import { useView, useViewErrorToast } from "@/lib/runtime/viewHooks";

// A device's config, as its host streams it (globalConfig:watch). Writes
// go through useSettingsSave (this machine) and useDeviceSettingsSave (a
// peer), which own the dirty diff, and the view follows them.
const globalConfigAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    view: callOf(globalConfigContract, "watch"),
    input: undefined,
  }),
);

// The scoped device's config. A hostless client has no local device
// config at all, so the local scope reads none there (a peer's does).
// This machine's failure is a toast; a peer's the remote settings pane
// says inline.
export function useGlobalConfig() {
  const { deviceId, hasHost } = useHostScope();
  const state = useView(hasHost ? globalConfigAtom(deviceId) : null);
  useViewErrorToast(
    deviceId === useApi().deviceId ? state : { error: null },
    "Couldn't load settings",
  );
  return state;
}

// The same pinned to THIS machine whatever scope the caller sits under,
// for the preferences that belong to the device doing the viewing
// (launchScripts on a peer's worktree page). Never read on a hostless
// client.
export function useLocalGlobalConfig() {
  const api = useApi();
  return useView(api.isElectron ? globalConfigAtom(api.deviceId) : null);
}
