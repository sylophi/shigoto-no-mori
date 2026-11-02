import { errorMessageOf } from "@shigomori/contracts/errors";
import type { GlobalConfig } from "@shigomori/contracts/schemas";
import { EmptyPanel } from "@shigomori/ui/primitives/empty-panel.tsx";
import { ErrorBanner } from "@shigomori/ui/primitives/error-banner.tsx";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { DeviceScope } from "@/hooks/remote/useHostScope";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import type { Device } from "@/lib/remote/devices";
import { deviceSections } from "./deviceSections";
import { HostPanels, onEveryHostTab } from "./SettingsPanel";
import type { HostTab } from "@shigomori/ui/views/settings/settingsSections.ts";
import { useDeviceSettingsForm } from "./useDeviceSettingsForm";
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
  device: Device;
  active: HostTab | undefined;
}) {
  const { reachable } = deviceStatusView(device.status);
  // Never reached at all: no wire to read the device's config over, so
  // there is nothing honest to render. Say where the settings are
  // instead of showing a form that could not save (or, worse, defaults
  // that would look like the device's real answers). Once shown, the
  // form and its unsaved edits stay through a blip (DeviceScope).
  return (
    <DeviceScope
      deviceId={device.deviceId}
      absent={
        <HostPanels
          deviceId={device.deviceId}
          active={active}
          sections={onEveryHostTab(<OfflineNote device={device} />)}
        />
      }
    >
      <ReachablePeerSettings
        device={device}
        offline={!reachable}
        active={active}
      />
    </DeviceScope>
  );
}

function OfflineNote({ device }: { device: Device }) {
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
function PeerVersion({ device }: { device: Device }) {
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
  device: Device;
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
  device: Device;
  initialConfig: GlobalConfig;
  offline: boolean;
  active: HostTab | undefined;
}) {
  // A reachable device this client may read but not command: the
  // verdict is a normal state, not an error. Show what the device has,
  // frozen, and name where the grant is made. While the verdict is
  // still in flight, assume granted rather than flashing a read-only
  // form that turns editable a moment later.
  const access = useCommandAccess();
  const readOnly = !access.canCommand;
  // Dirty is dirty even once the grant verdict lands as read-only
  // (edits made while it was in flight): the host refuses the save
  // and says so, rather than the footer quietly forgetting them.
  const { form, setForm, saveError } = useDeviceSettingsForm(
    device.deviceId,
    initialConfig,
  );

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
              saveError: saveError && (
                <ErrorBanner
                  message={saveError.message}
                  title="Couldn't save the device's settings"
                />
              ),
            })
      }
    />
  );
}
