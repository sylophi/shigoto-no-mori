import type { ReactNode } from "react";
import { errorMessageOf } from "@shared/errors";
import type { ReadGlobalConfig } from "@shared/schemas";
import { EmptyPanel } from "@/components/remote/EmptyPanel";
import { EditorFooter } from "@/components/shared/EditorFooter";
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
import {
  DeviceLauncherSections,
  DeviceToggleSections,
} from "./DeviceSettingsSections";
import { SettingsPane } from "./SettingsPane";

// The appearance half of the Settings page, staged and saved by
// SettingsForm. It stays editable while a peer is selected (it belongs
// to this window, not to any device), so its dirty state and its save
// ride the same footer as the peer's device settings: one page, one
// Save.
export interface ClientHalfEditor {
  isDirty: boolean;
  isPending: boolean;
  isSuccess: boolean;
  error: Error | null;
  // Never rejects: SettingsForm reports the failure through `error` and
  // the mutation's toast.
  save: () => Promise<void>;
  discard: () => void;
}

interface PeerProps {
  device: RemoteDevice;
  // The client-scoped sections plus the device switcher, rendered above
  // whichever device body is selected.
  header: ReactNode;
  client: ClientHalfEditor;
}

// Another device's settings, edited in place on /settings (the switcher
// picks which). Everything below the header routes through the
// HostScope this mounts (the scoped config read, the host-scoped
// queries inside the shared section components, and the
// writeDeviceSettings patch save), so no client-scoped call reaches for
// a peer, and the web shell renders it unchanged. Client-scoped and
// host-secret sections (CLI, data location, danger zone) are absent by
// construction: SettingsForm renders those only for this device.
export function PeerDeviceSettings({ device, header, client }: PeerProps) {
  const { reachable } = deviceStatusView(device.status);
  const api = device.api;

  // Unreachable: no wire to read the device's config over, so there is
  // nothing honest to render. Say where the settings are instead of
  // showing a form that could not save (or, worse, defaults that would
  // look like the device's real answers).
  if (!reachable || api === undefined) {
    return (
      <PeerShell header={header} footer={<ClientFooter client={client} />}>
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 select-text dark:text-amber-300">
          {device.label} is offline. Its settings live on that device and load
          when it reconnects.
        </p>
      </PeerShell>
    );
  }

  return (
    <HostScopeProvider deviceId={device.deviceId} api={api}>
      <ReachablePeerSettings device={device} header={header} client={client} />
    </HostScopeProvider>
  );
}

function ReachablePeerSettings({ device, header, client }: PeerProps) {
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
      <PeerShell header={header} footer={<ClientFooter client={client} />}>
        {isError ? (
          <EmptyPanel>
            Couldn&apos;t load this device&apos;s settings:{" "}
            {errorMessageOf(error)}.
          </EmptyPanel>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </PeerShell>
    );
  }

  return (
    <PeerSettingsForm
      device={device}
      header={header}
      client={client}
      initialConfig={config}
    />
  );
}

function PeerSettingsForm({
  device,
  header,
  client,
  initialConfig,
}: PeerProps & { initialConfig: ReadGlobalConfig }) {
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
  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty } =
    useDirtyForm<SettingsFormState>(fromConfig(initialConfig, {}));
  const deviceDirty = isDirty && !readOnly;

  const handleSave = async () => {
    // The appearance half first: it lands on this machine's disk and
    // cannot be refused, so a peer that rejects the patch never strands
    // an already-staged theme change.
    await client.save();
    if (!deviceDirty) return;
    try {
      await save.mutateAsync(form);
      setSavedSnapshot(form);
    } catch {
      // Surfaced by the mutation cache toast and the banner below.
      // The form stays dirty so the user can retry or discard.
    }
  };

  return (
    <PeerShell
      header={header}
      footer={
        <EditorFooter
          isDirty={client.isDirty || deviceDirty}
          isPending={client.isPending || save.isPending}
          isSuccess={client.isSuccess || save.isSuccess}
          onDiscard={() => {
            client.discard();
            setForm(savedSnapshot);
          }}
          onSave={() => void handleSave()}
        />
      }
    >
      {readOnly && (
        // Same shape as the offline note, in the neutral family: this is
        // a normal permission state, not a warning.
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground select-text">
          Read-only until {device.label} grants command access from its Devices
          page.
        </p>
      )}

      {/* inert rather than a disabled prop on every row: the sections
          are shared verbatim with the local form, and a read-only
          visitor needs them readable, just not operable. */}
      <div
        inert={readOnly}
        className={cn("flex flex-col gap-10", readOnly && "opacity-60")}
      >
        <DeviceToggleSections form={form} setForm={setForm} />
        <DeviceLauncherSections form={form} setForm={setForm} />
      </div>

      {save.error && <ErrorBanner>{save.error.message}</ErrorBanner>}
      {client.error && <ErrorBanner>{client.error.message}</ErrorBanner>}
    </PeerShell>
  );
}

// The footer for a peer body with no editable device form (offline,
// loading, or a failed read): only the appearance half can be saved.
function ClientFooter({ client }: { client: ClientHalfEditor }) {
  return (
    <EditorFooter
      isDirty={client.isDirty}
      isPending={client.isPending}
      isSuccess={client.isSuccess}
      onDiscard={client.discard}
      onSave={() => void client.save()}
    />
  );
}

// The same scroll-region-plus-footer chrome the local body renders, so
// switching devices swaps only what is inside the column.
function PeerShell({
  header,
  footer,
  children,
}: {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <SettingsPane>
        {header}
        {children}
      </SettingsPane>
      {footer}
    </>
  );
}
