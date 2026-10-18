import { callOf } from "@shigomori/contracts/contract";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
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

// The requests a device's settings feed (gh's answers, which its
// `githubCli` switch gates, and the launch tools) read again whenever
// those settings move, whoever wrote them: Settings, a peer's form or
// `sm config` in a terminal. The host follows the same settings from
// its store; this follows its view. Held
// for as long as the device's api lives, as its push watch is.
export function followDeviceSettings(
  registry: AtomRegistry.AtomRegistry,
  queryClient: QueryClient,
  deviceId: string,
): () => void {
  const keys = queryKeysFor(deviceId);
  let last: { readonly gh: string; readonly launch: string } | undefined;
  return registry.subscribe(
    globalConfigAtom(deviceId),
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const config = result.value;
      const next = {
        gh: JSON.stringify(config.githubCli ?? null),
        launch: JSON.stringify([
          config.launchers,
          config.hiddenLaunchers,
          config.launchScripts,
          config.terminal,
          config.editor,
        ]),
      };
      if (last !== undefined && next.gh !== last.gh) {
        refreshQueries(queryClient, { queryKey: keys.githubCliAll() });
      }
      if (last !== undefined && next.launch !== last.launch) {
        refreshQueries(queryClient, { queryKey: keys.launchersAll() });
      }
      last = next;
    },
    { immediate: true },
  );
}
