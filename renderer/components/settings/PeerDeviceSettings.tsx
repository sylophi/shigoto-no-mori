import { useEffect, useState } from "react";
import { errorMessageOf } from "@shared/errors";
import type { ReadGlobalConfig } from "@shared/schemas";
import { EmptyPanel } from "@/components/remote/EmptyPanel";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useDeviceSettingsSave } from "@/hooks/config/useDeviceSettingsSave";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import {
  fromConfig,
  type SettingsFormState,
} from "@/hooks/config/useSettingsSave";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { HostScopeProvider } from "@/hooks/remote/useHostScope";
import { useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDevice } from "@/lib/remote/devices";
import { cn } from "@/lib/utils";
import { DeviceToggleSections } from "./DeviceSettingsSections";
import { useRegisterSettingsEditor } from "./useSettingsEditors";
import { VersionSection } from "./VersionSection";

// Another device's section on the Settings page. Everything under the
// version routes through the HostScope this mounts (the scoped config
// read, the host-scoped queries inside the shared section components,
// the updater, and the writeDeviceSettings patch save), so no
// client-scoped call reaches for a peer. The local-only sections (CLI,
// data location, danger zone) are absent by construction: they act on
// a disk and a shell, and only the local section renders them.
export function PeerDeviceSettings({ device }: { device: RemoteDevice }) {
  const { reachable } = deviceStatusView(device.status);
  // The api of the last session the registry handed over. A hub or
  // session blip drops device.api while the keeper redials, and the
  // api object is one per device for the window's lifetime, so keeping
  // the last one mounted keeps a seeded form (and its unsaved edits)
  // alive across the blip instead of unmounting it with the note.
  const [api, setApi] = useState(device.api);
  if (device.api !== undefined && device.api !== api) setApi(device.api);
  const offline = !reachable || device.api === undefined;

  // Never reached at all: no wire to read the device's config over, so
  // there is nothing honest to render. Say where the settings are
  // instead of showing a form that could not save (or, worse, defaults
  // that would look like the device's real answers).
  if (api === undefined) return <OfflineNote device={device} />;

  return (
    <HostScopeProvider deviceId={device.deviceId} api={api}>
      <ReachablePeerSettings device={device} offline={offline} />
    </HostScopeProvider>
  );
}

function OfflineNote({ device }: { device: RemoteDevice }) {
  return (
    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 select-text dark:text-amber-300">
      {device.label} is offline. Its settings live on that device and load when
      it reconnects.
    </p>
  );
}

function ReachablePeerSettings({
  device,
  offline,
}: {
  device: RemoteDevice;
  offline: boolean;
}) {
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
  return (
    <>
      {offline ? (
        <OfflineNote device={device} />
      ) : (
        <PeerVersionSection device={device} />
      )}
      {config === undefined ? (
        offline ? null : isError ? (
          <EmptyPanel>
            Couldn&apos;t load this device&apos;s settings:{" "}
            {errorMessageOf(error)}.
          </EmptyPanel>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )
      ) : (
        <PeerSettingsForm
          device={device}
          initialConfig={config}
          offline={offline}
        />
      )}
    </>
  );
}

function PeerVersionSection({ device }: { device: RemoteDevice }) {
  return (
    <VersionSection
      version={
        device.appVersion === "" ? (
          <span className="text-muted-foreground">Not reported yet</span>
        ) : (
          `v${device.appVersion}`
        )
      }
    />
  );
}

function PeerSettingsForm({
  device,
  initialConfig,
  offline,
}: {
  device: RemoteDevice;
  initialConfig: ReadGlobalConfig;
  offline: boolean;
}) {
  const save = useDeviceSettingsSave();
  // A reachable device this client may read but not command: the
  // verdict is a normal state, not an error. Show what the device has,
  // frozen, and name where the grant is made. While the verdict is
  // still in flight, assume granted rather than flashing a read-only
  // form that turns editable a moment later.
  const { granted, isLoading } = useCommandAccess();
  const readOnly = !granted && !isLoading;
  // Same form shape as the local Settings form so the section
  // components are shared verbatim. The client half doesn't exist here:
  // theme/doubutsu seed from an empty client config, nothing in this
  // subtree renders or edits them (so they can never turn this form
  // dirty), and the patch encoder carries only the device-managed keys.
  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty, reseed } =
    useDirtyForm<SettingsFormState>(fromConfig(initialConfig, {}));
  // The section stays mounted across visits, so a background refetch of
  // the device's config (its own user changed a toggle) rebases the
  // form. Clean, it adopts the change. Dirty, the snapshot moves so
  // Save diffs against what the device has now.
  useEffect(() => {
    reseed(fromConfig(initialConfig, {}));
  }, [initialConfig, reseed]);

  const handleSave = async () => {
    if (!isDirty) return;
    try {
      await save.mutateAsync(form);
      setSavedSnapshot(form);
    } catch {
      // Surfaced by the mutation cache toast and the banner below.
      // The form stays dirty so the user can retry or discard.
    }
  };

  // The page's one footer saves and discards this form with the rest.
  // Dirty is dirty even once the grant verdict lands as read-only
  // (edits made while it was in flight): the host refuses the save
  // and says so, rather than the footer quietly forgetting them.
  useRegisterSettingsEditor(device.deviceId, {
    isDirty,
    isPending: save.isPending,
    isSuccess: save.isSuccess,
    save: handleSave,
    discard: () => setForm(savedSnapshot),
  });

  // Offline: the note above stands in for the sections. The form state
  // (and the registration) stays alive for when the device is back.
  if (offline) return null;

  return (
    <>
      {readOnly && (
        // Same shape as the offline note, in the neutral family: this is
        // a normal permission state, not a warning.
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground select-text">
          Read-only until {device.label} grants command access from its Devices
          page.
        </p>
      )}

      {/* inert rather than a disabled prop on every row: the sections
          are shared verbatim with the local tab, and a read-only
          visitor needs them readable, just not operable. */}
      <div
        inert={readOnly}
        className={cn("flex flex-col gap-10", readOnly && "opacity-60")}
      >
        <DeviceToggleSections form={form} setForm={setForm} />
      </div>

      {save.error && <ErrorBanner>{save.error.message}</ErrorBanner>}
    </>
  );
}
