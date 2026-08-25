import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessageOf } from "@shared/errors";
import type { ReadGlobalConfig } from "@shared/schemas";
import {
  DeviceLauncherSections,
  DeviceToggleSections,
} from "@/components/settings/DeviceSettingsSections";
import { EmptyPanel } from "./EmptyPanel";
import { EditorFooter } from "@/components/shared/EditorFooter";
import { ErrorBanner } from "@/components/ui/error-banner";
import {
  fromConfig,
  type SettingsFormState,
  toDeviceSettingsPatch,
} from "@/hooks/config/useSettingsSave";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { useHostScope } from "@/hooks/remote/useHostScope";
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

// Save = one idempotent patch of all seven managed keys through the
// scoped api, then the scoped mirror of useSettingsSave's local
// invalidation fan-out (config, launcher catalogs, gh readiness/PRs).
// No per-key diff and no second store: the patch write is cheap enough
// that an unchanged key riding along costs nothing. A refused save (the
// host revoked command access mid-edit) surfaces through the central
// CommandRefusedError toast; isPending resets either way, so Save
// re-enables for a retry.
function useDeviceSettingsSave() {
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (state: SettingsFormState) =>
      api.globalConfig.writeDeviceSettings(toDeviceSettingsPatch(state)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.globalConfig() });
      void queryClient.invalidateQueries({ queryKey: keys.launchersAll() });
      void queryClient.invalidateQueries({ queryKey: keys.githubCliAll() });
    },
    meta: { errorTitle: "Couldn't save settings" },
  });
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

// The same scroll-region-plus-column chrome the local SettingsForm
// renders, so the two settings surfaces read identically.
function SettingsPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="flex max-w-3xl flex-col gap-10">{children}</div>
    </div>
  );
}
