import { useEffect, useState } from "react";
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
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useTheme } from "@/hooks/ui/useTheme";
import { localDeviceId } from "@/lib/queryKeys";
import type { ClientConfig, GlobalConfig, Theme } from "@shared/schemas";
import { AppearanceSection } from "./AppearanceSection";
import { DangerZone } from "./DangerZone";
import { DataLocationSection } from "./DataLocationSection";
import { DeviceSwitcher } from "./DeviceSwitcher";
import {
  DeviceLauncherSections,
  DeviceToggleSections,
} from "./DeviceSettingsSections";
import { CliSection } from "./CliSection";
import {
  type ClientHalfEditor,
  PeerDeviceSettings,
} from "./PeerDeviceSettings";
import { SettingsPane } from "./SettingsPane";
import { VersionSection } from "./VersionSection";

// The Settings page, in three bands. The client-scoped sections
// (version, appearance) belong to THIS window and stay at the top for
// every selection. Under them, a device switcher scopes the
// device-managed sections to any machine on the account. Local-only
// sections (CLI, data location, danger zone) render for this device
// only -- they act on this machine's disk and mean nothing for a peer.
//
// This component keeps the whole client half plus the local device's
// form: it is never unmounted by a device switch, so unsaved appearance
// or local-device edits survive a look at another machine. A peer's
// form lives in PeerDeviceSettings, seeded from that device's own
// config read.
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
  const devices = useRemoteDevices();
  const [selectedDeviceId, setSelectedDeviceId] = useState(localDeviceId);
  // The selected peer, or undefined for this device. A device that
  // leaves the registry mid-visit (revoked, or the account signed out)
  // falls back to this device rather than stranding an empty selection.
  const peer = devices.find((d) => d.deviceId === selectedDeviceId);

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
    // its engine and skips whichever store is unchanged -- so while a
    // peer is selected, with no local device section rendered to edit,
    // this writes the appearance half alone.
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

  const header = (
    <>
      <VersionSection />

      <AppearanceSection
        theme={form.theme}
        onPick={pickTheme}
        doubutsu={form.doubutsu}
        onDoubutsuChange={setDoubutsu}
      />

      {/* One device means no choice to offer: the sections below are
          simply this machine's, exactly as before the switcher. */}
      {devices.length > 0 && (
        <DeviceSwitcher
          devices={devices}
          selectedPeer={peer}
          onChange={setSelectedDeviceId}
        />
      )}
    </>
  );

  if (peer !== undefined) {
    // Keyed: a different device is a different form, seeded from that
    // device's own config read.
    const client: ClientHalfEditor = {
      isDirty,
      isPending: save.isPending,
      isSuccess: save.isSuccess,
      error: save.error,
      save: handleSave,
      discard: handleDiscard,
    };
    return (
      <PeerDeviceSettings
        key={peer.deviceId}
        device={peer}
        header={header}
        client={client}
      />
    );
  }

  return (
    <>
      <SettingsPane>
        {header}

        <DeviceToggleSections form={form} setForm={setForm} />

        <CliSection />

        <DeviceLauncherSections form={form} setForm={setForm} />

        <DataLocationSection />

        <DangerZone />

        {save.error && <ErrorBanner>{save.error.message}</ErrorBanner>}
      </SettingsPane>
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
