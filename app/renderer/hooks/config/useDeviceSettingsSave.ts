import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  invalidateDeviceSettingsQueries,
  peerSettingsWrite,
} from "./useSettingsSave";
import type { SettingsFormState } from "@shigomori/ui/lib/settingsForm.ts";

// Save for the device-managed keys of whichever device the surrounding
// HostScope names: a patch of the keys the form changed from what it
// last saved, so a key the device's own user changed meanwhile is never
// written back. A refused save (the host revoked command access
// mid-edit) surfaces through the central CommandRefusedError toast.
//
// The local device's save does NOT come through here -- it writes two
// stores (device config plus this window's appearance) as one mutation
// through useSettingsSave, whose device half is this same patch write
// plus the launch catalog. This hook is for peers.
export function useDeviceSettingsSave() {
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      state,
      saved,
    }: {
      state: SettingsFormState;
      saved: SettingsFormState;
    }) => {
      await api.run(
        api.globalConfig.writeDeviceSettings({
          patch: peerSettingsWrite(saved, state),
        }),
      );
    },
    onSuccess: () => invalidateDeviceSettingsQueries(queryClient, keys),
    meta: { errorTitle: "Couldn't save settings" },
  });
}
