import { useMutation } from "@tanstack/react-query";
import type { DeviceSettingsPatch } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { changedKeys } from "@shigomori/ui/hooks/useDirtyForm.ts";
import type { DeviceFormState } from "@shigomori/ui/lib/settingsForm.ts";

// The globalConfig.writeDeviceSettings patch for a form. A launcher row
// persists only once both halves are filled in. Half-typed rows live
// purely in form state.
function toDeviceSettingsPatch(state: DeviceFormState): DeviceSettingsPatch {
  return {
    ...state,
    launchers: state.launchers.filter(
      (l) => l.label.trim().length > 0 && l.command.trim().length > 0,
    ),
  };
}

// Save for whichever device the surrounding HostScope names, this
// machine's or a peer's: a patch of the keys the form changed from what
// it last saved, so a key the device's own user changed meanwhile is
// never written back. The host applies it as absent-means-keep, so a
// changed key carries its value explicitly, default included (the host
// then stores it by omission). A refused save (the host revoked command
// access mid-edit) surfaces through the central CommandRefusedError
// toast.
export function useDeviceSettingsSave() {
  const { api } = useHostScope();
  return useMutation({
    mutationFn: async ({
      state,
      saved,
    }: {
      state: DeviceFormState;
      saved: DeviceFormState;
    }) => {
      const patch = changedKeys(
        toDeviceSettingsPatch(saved),
        toDeviceSettingsPatch(state),
      );
      if (Object.keys(patch).length === 0) return;
      await api.run(api.globalConfig.writeDeviceSettings({ patch }));
    },
    meta: { errorTitle: "Couldn't save settings" },
  });
}
