import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  invalidateDeviceSettingsQueries,
  type SettingsFormState,
  toDeviceSettingsPatch,
} from "./useSettingsSave";

// Save for the device-managed keys of whichever device the surrounding
// HostScope names: one idempotent patch of all seven keys through the
// scoped api, then the shared post-save fan-out (config, launcher
// catalogs, gh readiness/PRs, projects) against that device's registry.
// No per-key diff and no second store: the patch write is cheap enough
// that an unchanged key riding along costs nothing. A refused save (the
// host revoked command access mid-edit) surfaces through the central
// CommandRefusedError toast; isPending resets either way, so Save
// re-enables for a retry.
//
// The local device's save does NOT come through here -- it writes two
// stores (device config plus this window's appearance) through
// useSettingsSave, and its device half must stay on the local-only
// write path. This hook is for peers.
export function useDeviceSettingsSave() {
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (state: SettingsFormState) =>
      api.globalConfig.writeDeviceSettings(toDeviceSettingsPatch(state)),
    onSuccess: () => invalidateDeviceSettingsQueries(queryClient, keys),
    meta: { errorTitle: "Couldn't save settings" },
  });
}
