import { useMutation } from "@tanstack/react-query";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import { storedClientSetting } from "@shigomori/contracts/schemas/config";
import { storedPicks } from "@shigomori/ui/lib/themes.ts";
import { patchClientConfig } from "./useClientConfig";
import { useRegistry } from "@/lib/runtime/viewHooks";
import type { ClientFormState } from "@shigomori/ui/lib/settingsForm.ts";
import { useApi } from "@/lib/runtime/pageApi";
import { changedKeys } from "@shigomori/ui/hooks/useDirtyForm.ts";

// Appearance saves through the client-scoped store, each key omitted
// at its default.
function toClientConfig(state: ClientFormState): ClientConfig {
  return {
    theme: storedClientSetting("theme", state.theme),
    doubutsu: storedClientSetting("doubutsu", state.doubutsu),
    // Kept while the switch is off, so they come back with it.
    ...storedPicks(state.lightTheme, state.darkTheme),
    themeRotation: state.themeRotation ? state.themeRotationEvery : undefined,
    pauseAnimationsOnBattery: storedClientSetting(
      "pauseAnimationsOnBattery",
      state.pauseAnimationsOnBattery,
    ),
    darkTerminals: storedClientSetting("darkTerminals", state.darkTerminals),
    villageLife: storedClientSetting("villageLife", state.villageLife),
    villageNews: storedClientSetting("villageNews", state.villageNews),
    markTerrierProjects: storedClientSetting(
      "markTerrierProjects",
      state.markTerrierProjects,
    ),
    showDeviceBadges: storedClientSetting(
      "showDeviceBadges",
      state.showDeviceBadges,
    ),
    allowAgentWorking: storedClientSetting(
      "allowAgentWorking",
      state.allowAgentWorking,
    ),
    markAgentsWaiting: storedClientSetting(
      "markAgentsWaiting",
      state.markAgentsWaiting,
    ),
    notifyAgentWaiting: storedClientSetting(
      "notifyAgentWaiting",
      state.notifyAgentWaiting,
    ),
    notifyAgentDone: storedClientSetting(
      "notifyAgentDone",
      state.notifyAgentDone,
    ),
    inlineWorktrees: storedClientSetting(
      "inlineWorktrees",
      state.inlineWorktrees,
    ),
    // Only an action bound off its default is stored, so none is nothing.
    keybindings:
      Object.keys(state.keybindings).length > 0 ? state.keybindings : undefined,
  };
}

// This window's settings, as a patch of the keys the form changed from
// what it last saved (`saved`), so a form seeded while a read was
// failing, or before another window changed a key, never writes back
// what it did not change.
export function useSettingsSave() {
  const page = useApi();
  const registry = useRegistry();
  return useMutation({
    mutationFn: async ({
      state,
      saved,
    }: {
      state: ClientFormState;
      saved: ClientFormState;
    }): Promise<void> => {
      const changed = changedKeys(toClientConfig(saved), toClientConfig(state));
      if (Object.keys(changed).length === 0) return;
      // A pick or a rotation saved here starts a timed rotation's
      // period over.
      const restartsRotation = [
        "lightTheme",
        "darkTheme",
        "themeRotation",
      ].some((key) => key in changed);
      const patch = restartsRotation
        ? { ...changed, themeRotatedAt: Date.now() }
        : changed;
      await patchClientConfig(page, registry, patch);
    },
    meta: { errorTitle: "Couldn't save settings" },
  });
}
