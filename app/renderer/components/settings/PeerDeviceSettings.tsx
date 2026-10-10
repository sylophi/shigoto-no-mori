import { useEffect } from "react";
import { errorMessageOf } from "@shigomori/contracts/errors";
import type { GlobalConfig } from "@shigomori/contracts/schemas";
import { EmptyPanel } from "@shigomori/ui/primitives/empty-panel.tsx";
import { ErrorBanner } from "@shigomori/ui/primitives/error-banner.tsx";
import { useDeviceSettingsSave } from "@/hooks/config/useDeviceSettingsSave";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { fromConfig } from "@shigomori/ui/lib/settingsForm.ts";
import type { SettingsFormState } from "@shigomori/ui/lib/settingsForm.ts";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { HostScopeProvider } from "@/hooks/remote/useHostScope";
import { useLastGoodApi } from "@/hooks/remote/useLastGoodApi";
import { useDirtyForm } from "@shigomori/ui/hooks/useDirtyForm.ts";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import type { RemoteDevice } from "@/lib/remote/devices";
import { deviceSections } from "./deviceSections";
import { HostPanels, onEveryHostTab } from "./SettingsPanel";
import type { HostTab } from "@shigomori/ui/views/settings/settingsSections.ts";
import { useRegisterSettingsEditor } from "./useSettingsEditors";
import {
  PeerOfflineNoteView,
  PeerReadOnlyNoteView,
  PeerSettingsLoadingView,
  PeerVersionLineView,
} from "@shigomori/ui/views/settings/PeerDeviceSettingsView.tsx";
import { VersionSection } from "./VersionSection";

// Another device's host sections on the Settings page. Everything under
// the version routes through the HostScope this mounts (the scoped config
// read, the host-scoped queries inside the shared section components,
// the updater, and the writeDeviceSettings patch save), so no
// client-scoped call reaches for a peer. The health check, CLI and
// data location sections are the local ones mounted under this scope,
// so they act on the peer's shell and disk behind its command grant.
// The danger zone is absent by construction: wiping a machine is for
// whoever sits at it, and only the local General section renders it.
// `active` is the host section showing while this device is picked.
export function PeerDeviceSettings({
  device,
  active,
}: {
  device: RemoteDevice;
  active: HostTab | undefined;
}) {
  const { reachable } = deviceStatusView(device.status);
  const api = useLastGoodApi(device);
  const offline = !reachable || device.api === undefined;

  // Never reached at all: no wire to read the device's config over, so
  // there is nothing honest to render. Say where the settings are
  // instead of showing a form that could not save (or, worse, defaults
  // that would look like the device's real answers).
  if (api === undefined) {
    return (
      <HostPanels
        deviceId={device.deviceId}
        active={active}
        sections={onEveryHostTab(<OfflineNote device={device} />)}
      />
    );
  }

  return (
    <HostScopeProvider deviceId={device.deviceId} api={api}>
      <ReachablePeerSettings
        device={device}
        offline={offline}
        active={active}
      />
    </HostScopeProvider>
  );
}

function OfflineNote({ device }: { device: RemoteDevice }) {
  return (
    <PeerOfflineNoteView
      label={device.label}
      // Rostered but no session yet ("online" is the one phase that
      // says the machine itself is up).
      dialing={device.status.phase === "online"}
    />
  );
}

// The build the device reported, at the head of its General section.
function PeerVersion({ device }: { device: RemoteDevice }) {
  return (
    <VersionSection
      installed={device.appVersion}
      version={<PeerVersionLineView appVersion={device.appVersion} />}
    />
  );
}

function ReachablePeerSettings({
  device,
  offline,
  active,
}: {
  device: RemoteDevice;
  offline: boolean;
  active: HostTab | undefined;
}) {
  const { data: config, isError, error } = useGlobalConfig();

  // Unlike the local form, never fall back to an empty config: a form
  // seeded from defaults would save those defaults over the device's
  // real settings. Gate on data presence only, not isError, so a view
  // that fails after its first value (a flaky socket) cannot unmount an
  // already-seeded form and discard unsaved edits.
  if (config === undefined) {
    const status = offline ? (
      <OfflineNote device={device} />
    ) : isError ? (
      <EmptyPanel>
        Couldn&apos;t load this device&apos;s settings: {errorMessageOf(error)}.
      </EmptyPanel>
    ) : (
      <PeerSettingsLoadingView />
    );
    return (
      <HostPanels
        deviceId={device.deviceId}
        active={active}
        sections={{
          ...onEveryHostTab(status),
          general: (
            <>
              {!offline && <PeerVersion device={device} />}
              {status}
            </>
          ),
        }}
      />
    );
  }
  return (
    <PeerSettingsForm
      device={device}
      initialConfig={config}
      offline={offline}
      active={active}
    />
  );
}

function PeerSettingsForm({
  device,
  initialConfig,
  offline,
  active,
}: {
  device: RemoteDevice;
  initialConfig: GlobalConfig;
  offline: boolean;
  active: HostTab | undefined;
}) {
  const save = useDeviceSettingsSave();
  // A reachable device this client may read but not command: the
  // verdict is a normal state, not an error. Show what the device has,
  // frozen, and name where the grant is made. While the verdict is
  // still in flight, assume granted rather than flashing a read-only
  // form that turns editable a moment later.
  const access = useCommandAccess();
  const readOnly = !access.canCommand;
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

  // Offline: the note stands in for the sections. The form state (and
  // the registration) stays alive for when the device is back.
  return (
    <HostPanels
      deviceId={device.deviceId}
      active={active}
      sections={
        offline
          ? onEveryHostTab(<OfflineNote device={device} />)
          : deviceSections({
              form,
              setForm,
              version: <PeerVersion device={device} />,
              // On the landed verdict, not the optimistic one the
              // toggles use: these sections read on mount, and asking a
              // device that turns out not to allow it is a refusal per
              // read.
              commands: access.granted,
              readOnly,
              note: readOnly && <PeerReadOnlyNoteView label={device.label} />,
              saveError: save.error && (
                <ErrorBanner
                  message={save.error.message}
                  title="Couldn't save the device's settings"
                />
              ),
            })
      }
    />
  );
}
