import { errorMessageOf } from "@shared/errors";
import type { ReadGlobalConfig } from "@shared/schemas";
import {
  DeviceLauncherSections,
  DeviceToggleSections,
} from "@/components/settings/DeviceSettingsSections";
import { SettingsPane } from "@/components/settings/SettingsPane";
import { EmptyPanel } from "./EmptyPanel";
import { EditorFooter } from "@/components/shared/EditorFooter";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useDeviceSettingsSave } from "@/hooks/config/useDeviceSettingsSave";
import {
  fromConfig,
  type SettingsFormState,
} from "@/hooks/config/useSettingsSave";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { useDirtyForm } from "@/hooks/ui/useDirtyForm";

// The remote device's Settings body (v2 step 6): the seven
// device-managed keys, edited in place on the /devices/$deviceId page.
// Everything routes through the surrounding HostScope — the redacted
// scoped read below, the host-scoped queries inside the shared section
// components, and the writeDeviceSettings patch save — so no
// client-scoped call and no local route appears anywhere on this path,
// and the web shell renders it unchanged. The client-scoped and
// host-secret sections of the local form (appearance, updater, CLI,
// hosting, remote devices, account, data location, danger zone) are
// deliberately absent: they are either this window's concerns or
// structurally excluded from the remote write surface.
export function RemoteDeviceSettings() {
  const {
    data: config,
    isError,
    error,
  } = useGlobalConfig({
    silentError: true,
  });

  // Unlike the local form, never fall back to an empty config: a form
  // seeded from defaults would save those defaults over the device's
  // real settings. Gate on data presence only, not isError, so a failed
  // BACKGROUND refetch (focus refetch over a flaky socket) cannot
  // unmount an already-seeded form and discard unsaved edits.
  if (config === undefined) {
    return (
      <SettingsPane>
        {isError ? (
          <EmptyPanel>
            Couldn&apos;t load this device&apos;s settings:{" "}
            {errorMessageOf(error)}.
          </EmptyPanel>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </SettingsPane>
    );
  }
  return <RemoteDeviceSettingsForm initialConfig={config} />;
}

function RemoteDeviceSettingsForm({
  initialConfig,
}: {
  initialConfig: ReadGlobalConfig;
}) {
  const save = useDeviceSettingsSave();
  // Same form shape as the local Settings form so the section
  // components are shared verbatim. The client half doesn't exist here:
  // theme/doubutsu seed from an empty client config, nothing renders or
  // edits them (so they can never turn the form dirty), and the patch
  // encoder carries only the seven managed keys.
  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty } =
    useDirtyForm<SettingsFormState>(fromConfig(initialConfig, {}));

  const handleSave = async () => {
    try {
      await save.mutateAsync(form);
      setSavedSnapshot(form);
    } catch {
      // Surfaced by the mutation cache toast and the banner below; the
      // form stays dirty so the user can retry or discard.
    }
  };

  return (
    <>
      <SettingsPane>
        <p className="text-xs text-muted-foreground">
          These settings are stored on the remote device and apply wherever it
          runs.
        </p>
        <DeviceToggleSections form={form} setForm={setForm} />
        <DeviceLauncherSections form={form} setForm={setForm} />
        {save.error && <ErrorBanner>{save.error.message}</ErrorBanner>}
      </SettingsPane>
      <EditorFooter
        isDirty={isDirty}
        isPending={save.isPending}
        isSuccess={save.isSuccess}
        onDiscard={() => setForm(savedSnapshot)}
        onSave={() => void handleSave()}
      />
    </>
  );
}
