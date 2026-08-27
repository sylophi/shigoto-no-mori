import { useEffect } from "react";
import { EditorFooter } from "@/components/shared/EditorFooter";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import {
  fromConfig,
  type SettingsFormState,
  SettingsSaveError,
  useSettingsSave,
} from "@/hooks/config/useSettingsSave";
import { useTheme } from "@/hooks/ui/useTheme";
import type { ClientConfig, GlobalConfig, Theme } from "@shared/schemas";
import { AppearanceSection } from "./AppearanceSection";
import { DangerZone } from "./DangerZone";
import { DataLocationSection } from "./DataLocationSection";
import {
  DeviceLauncherSections,
  DeviceToggleSections,
} from "./DeviceSettingsSections";
import { HostingSection } from "./HostingSection";
import { RemoteDevicesSection } from "./RemoteDevicesSection";
import { CliSection } from "./CliSection";
import { VersionSection } from "./VersionSection";

export function SettingsForm({
  initialConfig,
  initialClientConfig,
}: {
  initialConfig: GlobalConfig;
  initialClientConfig: ClientConfig;
}) {
  const save = useSettingsSave({ initialConfig, initialClientConfig });
  const { setOverride } = useTheme();
  const { setOverride: setDoubutsuOverride } = useDoubutsu();

  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty } =
    useDirtyForm<SettingsFormState>(
      fromConfig(initialConfig, initialClientConfig),
    );

  // Drop any staged previews when leaving the settings page so the rest
  // of the app falls back to the saved values.
  useEffect(
    () => () => {
      setOverride(null);
      setDoubutsuOverride(null);
    },
    [setOverride, setDoubutsuOverride],
  );

  const handleSave = async () => {
    // Two stores behind one Save. useSettingsSave routes each field to
    // its engine and skips whichever store is unchanged.
    try {
      await save.mutateAsync(form);
      setSavedSnapshot(form);
    } catch (error) {
      // The mutation's toast and the banner below already surface the
      // failure. A partial failure still landed the device half, so
      // advance the snapshot for it: only the appearance fields stay
      // unsaved and Save retries just those.
      if (error instanceof SettingsSaveError && error.devicePersisted) {
        setSavedSnapshot((prev) => ({
          ...form,
          theme: prev.theme,
          doubutsu: prev.doubutsu,
        }));
      }
    }
    // No explicit setOverride(null) -- the providers clear the override
    // automatically once `saved` catches up to the staged value.
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
    setOverride(null);
    setDoubutsuOverride(null);
  };

  const pickTheme = (theme: Theme) => {
    setForm((prev) => ({ ...prev, theme }));
    setOverride(theme);
  };

  const setDoubutsu = (next: boolean) => {
    setForm((prev) => ({ ...prev, doubutsu: next }));
    setDoubutsuOverride(next);
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-10">
          <VersionSection />

          <AppearanceSection
            theme={form.theme}
            onPick={pickTheme}
            doubutsu={form.doubutsu}
            onDoubutsuChange={setDoubutsu}
          />

          <DeviceToggleSections form={form} setForm={setForm} />

          <CliSection />

          <HostingSection />

          <RemoteDevicesSection />

          <DeviceLauncherSections form={form} setForm={setForm} />

          <DataLocationSection />

          <DangerZone />

          {save.error && <ErrorBanner>{save.error.message}</ErrorBanner>}
        </div>
      </div>
      <EditorFooter
        isDirty={isDirty}
        isPending={save.isPending}
        isSuccess={save.isSuccess}
        onDiscard={handleDiscard}
        onSave={() => void handleSave()}
      />
    </>
  );
}
