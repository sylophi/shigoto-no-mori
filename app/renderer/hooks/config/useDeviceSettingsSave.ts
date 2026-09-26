import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GlobalConfig } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  invalidateDeviceSettingsQueries,
  type SettingsFormState,
  toDeviceSettingsPatch,
} from "./useSettingsSave";

// Save for the device-managed keys of whichever device the surrounding
// HostScope names: one idempotent patch of every key it edits through
// the scoped api, then the shared post-save fan-out (config, launcher
// catalogs, gh readiness/PRs, projects) against that device's registry.
// No per-key diff and no second store: the patch write is cheap enough
// that an unchanged key riding along costs nothing. A refused save (the
// host revoked command access mid-edit) surfaces through the central
// CommandRefusedError toast. isPending resets either way, so Save
// re-enables for a retry.
//
// The local device's save does NOT come through here -- it writes two
// stores (device config plus this window's appearance) as one mutation
// through useSettingsSave, whose device half is this same patch write
// plus the launch catalog. This hook is for peers.
export function useDeviceSettingsSave() {
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (state: SettingsFormState) =>
      api.globalConfig.writeDeviceSettings(toDeviceSettingsPatch(state)),
    // Read before the write lands, while the cached config is still
    // the one the form was seeded from.
    onMutate: (state) => ({
      worktreeNamesChanged:
        (queryClient.getQueryData<GlobalConfig>(keys.globalConfig())
          ?.codexWorktreeNames ?? false) !== state.codexWorktreeNames,
    }),
    onSuccess: (_, __, { worktreeNamesChanged }) =>
      invalidateDeviceSettingsQueries(queryClient, keys, worktreeNamesChanged),
    meta: { errorTitle: "Couldn't save settings" },
  });
}
