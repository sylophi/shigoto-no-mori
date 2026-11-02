import { useEffect } from "react";
import type { GlobalConfig } from "@shigomori/contracts/schemas";
import { keepTouched, useDirtyForm } from "@shigomori/ui/hooks/useDirtyForm.ts";
import {
  type DeviceFormState,
  fromDeviceConfig,
} from "@shigomori/ui/lib/settingsForm.ts";
import { useDeviceSettingsSave } from "@/hooks/config/useDeviceSettingsSave";
import { useRegisterSettingsEditor } from "./useSettingsEditors";

// One device's form on the Settings page, this machine's or a peer's,
// seeded from that device's config read and saved to the device the
// surrounding HostScope names. It spans the device's host sections
// (and, for this machine, Launch tools), and the page's one footer
// saves and discards it with the rest.
export function useDeviceSettingsForm(deviceId: string, config: GlobalConfig) {
  const save = useDeviceSettingsSave();
  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty, reseed } =
    useDirtyForm<DeviceFormState>(fromDeviceConfig(config));
  // The device's config moved (its own user or another window changed
  // a toggle): the form follows it, keeping the fields changed here
  // unsaved over it.
  useEffect(() => {
    reseed(fromDeviceConfig(config), keepTouched);
  }, [config, reseed]);

  const handleSave = async () => {
    if (!isDirty) return;
    const saved = savedSnapshot;
    try {
      await save.mutateAsync({ state: form, saved });
      // Only the fields this Save carried advance: a change the device
      // made to another field while it was out stays the device's.
      setSavedSnapshot((prev) => keepTouched(form, saved, prev));
    } catch {
      // Surfaced by the mutation cache toast and the form's banner.
      // The form stays dirty so the user can retry or discard.
    }
  };

  useRegisterSettingsEditor(deviceId, {
    isDirty,
    isPending: save.isPending,
    isSuccess: save.isSuccess,
    save: handleSave,
    discard: () => {
      setForm(savedSnapshot);
      save.reset();
    },
  });

  return { form, setForm, saveError: save.error };
}
