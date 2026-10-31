import { callOf } from "@shigomori/contracts/contract";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import { DEVICE_SETTINGS_DEFAULTS } from "@shigomori/contracts/schemas";
import type { QueryClient } from "@tanstack/react-query";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { refreshQueries } from "@/lib/askAgain";
import { queryKeysFor } from "@/lib/queryKeys";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useApi } from "@/lib/runtime/pageApi";
import { useView, useViewErrorToast } from "@/lib/runtime/viewHooks";

// A device's config, as its host streams it (globalConfig:watch). Writes
// go through useSettingsSave (this machine) and useDeviceSettingsSave (a
// peer), which own the dirty diff, and the view follows them, as it
// does `sm config`.
const globalConfigAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    view: callOf(globalConfigContract, "watch"),
    input: undefined,
  }),
);

// The scoped device's config. A hostless client has no local device
// config at all, so the local scope reads none there (a peer's does).
// This machine's failure is a toast, and a peer's is said inline by
// the remote settings pane.
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

// gh's answers read again when the device's `githubCli` switch moves,
// whoever moved it (Settings, a peer's form, `sm config`). The rest of a
// device's settings writes reach its requests through the push watch's
// externalChange, which leaves gh's keys out for their cost; the host
// gates them on this switch (GithubCli.unavailableReason). Held beside
// each device's push watch, so a peer's config view stays up for the
// account's life: retried while the peer refuses it, and started again
// with each new session to it.
export function followDeviceSettings(
  registry: AtomRegistry.AtomRegistry,
  queryClient: QueryClient,
  deviceId: string,
): () => void {
  const keys = queryKeysFor(deviceId);
  let last: boolean | undefined;
  return registry.subscribe(
    globalConfigAtom(deviceId),
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const on = result.value.githubCli ?? DEVICE_SETTINGS_DEFAULTS.githubCli;
      if (last !== undefined && on !== last) {
        refreshQueries(queryClient, { queryKey: keys.githubCliAll() });
      }
      last = on;
    },
    { immediate: true },
  );
}
