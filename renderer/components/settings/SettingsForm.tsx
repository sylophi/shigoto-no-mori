import { type ReactNode, useEffect, useState } from "react";
import { EditorFooter } from "@/components/shared/EditorFooter";
import { PageHeader } from "@/components/shared/PageHeader";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  fromConfig,
  type SettingsFormState,
  SettingsSaveError,
  useSettingsSave,
} from "@/hooks/config/useSettingsSave";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useUpdater } from "@/hooks/system/useUpdater";
import { useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useTheme } from "@/hooks/ui/useTheme";
import { hasLocalHost } from "@/lib/localHost";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { ClientConfig, GlobalConfig, Theme } from "@shared/schemas";
import type { RemoteDevice } from "@/lib/remote/devices";
import { AppearanceSection } from "./AppearanceSection";
import { DeviceStatusPill } from "@/components/remote/DeviceStatusPill";
import { LaunchToolsPanel } from "./LaunchToolsPanel";
import { LocalDevicePanel } from "./LocalDevicePanel";
import { PeerDeviceSettings } from "./PeerDeviceSettings";
import { SettingsSectionChips } from "./SettingsSectionChips";
import {
  APPEARANCE_TAB,
  deviceTab,
  isSolo,
  LAUNCH_TAB,
  landOnStagedUpdate,
  LOCAL_DEVICE_TAB,
  settingsPanelId,
  useActiveSettingsTab,
} from "./settingsNav";
import {
  SettingsEditorRegistryProvider,
  useSettingsEditorRegistry,
} from "./useSettingsEditors";
import { BuildVersionLine } from "./VersionSection";

// The Settings page: one panel per section, picked from the app
// sidebar (SettingsSidebarNav takes the project tree's place while this
// page is open).
//
// "Visual" is what this window shows (Appearance, Launch tools):
// controlled on this machine and never offered for another. "Devices"
// is one section per machine on the account, this one first,
// and everything in such a section is stored on that machine: its
// update, its worktree and integration toggles, and (for this machine
// alone) the sections that act on its disk.
//
// One form backs the three local sections (client config and this
// device's config save together through useSettingsSave), and each
// peer section seeds its own form from that device's config read.
// Sections mount on first visit and stay mounted (SettingsPanel), so
// switching never drops an edit, and the one footer saves and discards
// every form at once.
//
// A hostless client (the web shell) has no machine behind the window:
// Launch tools and this device's section are not offered, so its local
// form only ever carries appearance, and every device section is a
// peer's, edited over that peer's direct session exactly as from
// another desktop.
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
  const localName = useLocalDeviceName();
  const { activeTab, peer } = useActiveSettingsTab(devices);

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

  // The peer forms, as the footer sees them.
  const {
    registry,
    summary: peers,
    saveAll,
    discardAll,
  } = useSettingsEditorRegistry();
  const anyDirty = isDirty || peers.isDirty;
  const anyPending = save.isPending || peers.isPending;
  const anySuccess = save.isSuccess || peers.isSuccess;

  // This machine first: its write lands on this disk and cannot be
  // refused, so a peer that rejects its patch never strands a staged
  // local change. Each peer surfaces its own failure and stays dirty.
  const handleSaveAll = async () => {
    if (isDirty) await handleSave();
    await saveAll();
  };
  const handleDiscardAll = () => {
    handleDiscard();
    discardAll();
  };

  const heading = headingFor(activeTab, peer, localName, isSolo(devices));

  return (
    // The page marker picks the settings wallpaper (doubutsu.css), the
    // same one the loading skeleton in Settings.tsx wears.
    <div data-doubutsu-page="settings" className="flex h-full flex-col">
      {hasLocalHost && <StagedUpdateLanding />}
      <PageHeader
        eyebrow={heading.eyebrow}
        title={heading.title}
        watermark="設定"
      />
      <SettingsSectionChips devices={devices} activeTab={activeTab} />

      <SettingsEditorRegistryProvider registry={registry}>
        <div className="flex min-h-0 flex-1 flex-col">
          <SettingsPanel
            id={APPEARANCE_TAB}
            active={activeTab === APPEARANCE_TAB}
          >
            <AppearanceSection
              heading="Theme"
              theme={form.theme}
              onPick={pickTheme}
              doubutsu={form.doubutsu}
              onDoubutsuChange={setDoubutsu}
            />
            {/* The desktop states its build in this device's section.
                A hostless client has no such section, and its build is
                still worth a line, so it goes with the other setting
                that is about this window. */}
            {!hasLocalHost && <ClientVersionSection />}
          </SettingsPanel>

          {hasLocalHost && (
            <SettingsPanel id={LAUNCH_TAB} active={activeTab === LAUNCH_TAB}>
              <LaunchToolsPanel form={form} setForm={setForm} />
            </SettingsPanel>
          )}

          {hasLocalHost && (
            <SettingsPanel
              id={LOCAL_DEVICE_TAB}
              active={activeTab === LOCAL_DEVICE_TAB}
            >
              <LocalDevicePanel form={form} setForm={setForm} />
            </SettingsPanel>
          )}

          {devices.map((device) => {
            const id = deviceTab(device.deviceId);
            return (
              <SettingsPanel
                key={device.deviceId}
                id={id}
                active={activeTab === id}
              >
                {/* Keyed by device: a different machine is a different
                    form, seeded from that device's own config read. */}
                <PeerDeviceSettings device={device} />
              </SettingsPanel>
            );
          })}
        </div>
      </SettingsEditorRegistryProvider>

      {/* The local save spans three sections, so its failure is shown
          above the footer where every section can see it. Peer saves
          report inside their own section. */}
      {save.error && (
        <div className="px-6 pb-3">
          <ErrorBanner>{save.error.message}</ErrorBanner>
        </div>
      )}

      <EditorFooter
        isDirty={anyDirty}
        isPending={anyPending}
        isSuccess={anySuccess}
        onDiscard={handleDiscardAll}
        onSave={() => void handleSaveAll()}
      />
    </div>
  );
}

// No provider above the form, so this is the local updater: the
// sidebar's update dot brought the visitor here for its button. Only on
// arrival, though. A check that finishes while the page is open must
// not yank the visitor out of the section they are editing. Mounted
// only where a local updater exists (a hostless client has none).
function StagedUpdateLanding() {
  const { state: localUpdate } = useUpdater();
  const [stagedOnArrival] = useState(() =>
    localUpdate?.kind === "ready" ? localUpdate.version : null,
  );
  useEffect(() => {
    if (stagedOnArrival !== null) landOnStagedUpdate(stagedOnArrival);
  }, [stagedOnArrival]);
  return null;
}

// The build this hostless client runs.
function ClientVersionSection() {
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Web client</SectionHeading>
      <div className="font-mono text-sm select-text">
        <BuildVersionLine />
      </div>
    </section>
  );
}

// The header names the section the sidebar picked, the way a
// sidebar-driven settings window does, so the pane never has to repeat
// the list. A device's title carries its state pill: the one fact about
// a machine worth showing above its settings.
function headingFor(
  activeTab: string,
  peer: RemoteDevice | undefined,
  localName: string,
  // One machine on the account: no roster to place it in, so its
  // title carries neither the device eyebrow nor a presence pill.
  solo: boolean,
): { eyebrow: string; title: ReactNode } {
  if (activeTab === APPEARANCE_TAB) {
    return { eyebrow: "Settings", title: "Appearance" };
  }
  if (activeTab === LAUNCH_TAB) {
    return { eyebrow: "Settings", title: "Launch tools" };
  }
  if (solo) return { eyebrow: "Settings", title: localName };
  return {
    eyebrow: "Device settings",
    title: (
      <span className="inline-flex max-w-full items-center gap-2">
        <span className="truncate">{peer?.label ?? localName}</span>
        {peer === undefined ? (
          <DeviceStatusPill tone="emerald" label="This device" />
        ) : (
          <DeviceStatusPill {...deviceStatusView(peer.status)} />
        )}
      </span>
    ),
  };
}

// One section's body: its own scroll region (so each section keeps its
// scroll position) around the width-capped settings column. Mounts its
// content on the first visit and keeps it mounted afterwards (`hidden`
// parks it), so a form and its scroll position survive a look at
// another section, while a section never visited costs nothing.
function SettingsPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(active);
  if (active && !shown) setShown(true);
  return (
    <div
      id={settingsPanelId(id)}
      hidden={!active}
      className="min-h-0 flex-1 overflow-y-auto p-6"
    >
      {shown && (
        <div className="flex max-w-3xl flex-col gap-10">{children}</div>
      )}
    </div>
  );
}
