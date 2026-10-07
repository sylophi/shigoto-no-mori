import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
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
import {
  DeviceTabBar,
  pickHostDevice,
  useDeviceRoster,
  useHostDevicePick,
  type DeviceRosterEntry,
} from "@/components/shared/DeviceTabs";
import { UpdateMark } from "@/components/ui/status-dot";
import { useHostDevices } from "@/hooks/remote/useRemoteDevices";
import {
  useOutdatedDevices,
  useStagedUpdates,
} from "@/hooks/system/useUpdater";
import { fieldSetter, useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { usePalette } from "@/hooks/ui/usePalette";
import { useTheme } from "@/hooks/ui/useTheme";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import type { ClientConfig, GlobalConfig, Theme } from "@shared/schemas";
import type { DarkTheme, LightTheme } from "@shared/themes";
import { AppearanceSection } from "./AppearanceSection";
import { WorktreePrefixesSection } from "./WorktreePrefixesSection";
import { LaunchToolsPanel } from "./LaunchToolsPanel";
import { LocalDevicePanel } from "./LocalDevicePanel";
import { PeerDeviceSettings } from "./PeerDeviceSettings";
import { SettingsSectionChips } from "./SettingsSectionChips";
import { SidebarSection } from "./SidebarSection";
import { MountOnceVisited, SettingsPanel } from "./SettingsPanel";
import {
  APPEARANCE_TAB,
  GENERAL_TAB,
  isHostTab,
  LAUNCH_TAB,
  landOnStagedUpdate,
  settingsPanelId,
  useActiveSettingsTab,
  SECTION_LABELS,
  type SettingsTab,
  VISITORS_TAB,
} from "./settingsNav";
import { offersUpdateAll, UpdateAllButton } from "./UpdateAllButton";
import { VisitorsSection } from "@/components/visitors/VisitorsSection";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import {
  SettingsEditorRegistryProvider,
  useSettingsEditorRegistry,
} from "./useSettingsEditors";
import { ChangelogDialog } from "./ChangelogDialog";
import { BuildVersionLine, ChangelogButton } from "./VersionSection";
import { PAGE_BODY } from "@/components/shared/PageShell";

// The Settings page: one panel per section, picked from the app
// sidebar (SettingsSidebarNav takes the project tree's place while this
// page is open).
//
// "Client" is what this window shows (Appearance, Launch tools):
// controlled on this machine and never offered for another. "Host" is
// what each machine stores (General, Worktrees, Integrations), shown for
// the machine picked in the header's device tab bar, this one first:
// its update, its worktree and integration toggles, and the sections
// that act on its disk (a peer's only while it allows control, and
// never its danger zone).
//
// One form backs the client sections and this device's host sections
// (client config and this device's config save together through
// useSettingsSave), and each peer seeds its own form from that device's
// config read, which spans its three host sections. Sections mount on
// first visit and stay mounted (SettingsPanel), so switching section or
// device never drops an edit, and the one footer saves and discards
// every form at once.
//
// A hostless client (the web shell) has no machine behind the window:
// Launch tools and this device's sections are not offered, so its local
// form only ever carries appearance, and every device in the tab bar
// is a peer, edited over that peer's direct session exactly as from
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
  const { setOverride: setPaletteOverride } = usePalette();
  const devices = useHostDevices();
  const roster = useDeviceRoster();
  const activeTab = useActiveSettingsTab();
  const hostTab = isHostTab(activeTab) ? activeTab : undefined;
  const picked = useHostDevicePick(roster);
  // The host section a device's panels show: the active one while that
  // device is picked, none otherwise.
  const hostTabFor = (deviceId: string) =>
    picked?.deviceId === deviceId ? hostTab : undefined;
  const villageLife = useVillageLife();

  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty } =
    useDirtyForm<SettingsFormState>(
      fromConfig(initialConfig, initialClientConfig),
    );
  const setField = fieldSetter(setForm);

  // Drop any staged previews when leaving the settings page so the rest
  // of the app falls back to the saved values.
  useEffect(
    () => () => {
      setOverride(null);
      setPaletteOverride(null);
    },
    [setOverride, setPaletteOverride],
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
          lightTheme: prev.lightTheme,
          darkTheme: prev.darkTheme,
          pauseAnimationsOnBattery: prev.pauseAnimationsOnBattery,
          villageLife: prev.villageLife,
          markTerrierProjects: prev.markTerrierProjects,
          showDeviceBadges: prev.showDeviceBadges,
        }));
      }
    }
    // No explicit setOverride(null). The providers clear the override
    // automatically once `saved` catches up to the staged value.
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
    setOverride(null);
    setPaletteOverride(null);
  };

  const pickTheme = (theme: Theme) => {
    setForm((prev) => ({ ...prev, theme }));
    setOverride(theme);
  };

  const setDoubutsu = (next: boolean) => {
    setForm((prev) => ({ ...prev, doubutsu: next }));
    setPaletteOverride({ doubutsu: next });
  };

  // A pick previews at once, like the appearance: the light one shows
  // while the window is light, the dark one while it is dark, and
  // the other waits for its appearance.
  const pickLightTheme = (lightTheme: LightTheme) => {
    setForm((prev) => ({ ...prev, lightTheme }));
    setPaletteOverride({ light: lightTheme });
  };
  const pickDarkTheme = (darkTheme: DarkTheme) => {
    setForm((prev) => ({ ...prev, darkTheme }));
    setPaletteOverride({ dark: darkTheme });
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

  const updates = useStagedUpdates();
  useStagedUpdateLanding(updates);

  const heading = headingFor(activeTab);
  // This device alone means no choice to make: the sections read as
  // its own, with no tab bar, like Tidy. A peer always gets its tab,
  // even alone (a hostless client on a one-desktop account), since the
  // bar is what says which machine the sections edit and whether it is
  // connected.
  const tabs =
    hostTab !== undefined &&
    picked !== undefined &&
    roster.some((entry) => !entry.isThisDevice) ? (
      <HostTabBar
        roster={roster}
        picked={picked.deviceId}
        updates={hostTab === GENERAL_TAB ? updates : undefined}
      />
    ) : undefined;

  return (
    // The page marker picks the settings wallpaper (doubutsu.css), the
    // same one the loading skeleton in Settings.tsx wears. Visitors
    // wears its own.
    <div
      data-doubutsu-page={heading.page ?? "settings"}
      className="flex h-full flex-col"
    >
      <PageHeader
        eyebrow={heading.eyebrow}
        title={heading.title}
        watermark={heading.watermark ?? "設定"}
        tabs={tabs}
      />
      <SettingsSectionChips
        activeTab={activeTab}
        update={Object.keys(updates).length > 0}
      />

      <SettingsEditorRegistryProvider registry={registry}>
        <div className="flex min-h-0 flex-1 flex-col">
          <SettingsPanel
            id={settingsPanelId(APPEARANCE_TAB)}
            active={activeTab === APPEARANCE_TAB}
          >
            <AppearanceSection
              heading="Theme"
              theme={form.theme}
              onPick={pickTheme}
              doubutsu={form.doubutsu}
              onDoubutsuChange={setDoubutsu}
              lightTheme={form.lightTheme}
              onLightThemeChange={pickLightTheme}
              darkTheme={form.darkTheme}
              onDarkThemeChange={pickDarkTheme}
              pauseAnimationsOnBattery={form.pauseAnimationsOnBattery}
              onPauseAnimationsOnBatteryChange={setField(
                "pauseAnimationsOnBattery",
              )}
              villageLife={form.villageLife}
              onVillageLifeChange={setField("villageLife")}
            />
            <SidebarSection form={form} setForm={setForm} />
            <WorktreePrefixesSection list="hidden" />
            <WorktreePrefixesSection list="grouped" />
            {/* The desktop states its build in this device's General
                section. A hostless client has no such section, and its
                build is still worth a line, so it goes with the other
                setting that is about this window. */}
            {!hasLocalHost && <ClientVersionSection />}
          </SettingsPanel>

          {hasLocalHost && (
            <SettingsPanel
              id={settingsPanelId(LAUNCH_TAB)}
              active={activeTab === LAUNCH_TAB}
            >
              <LaunchToolsPanel form={form} setForm={setForm} />
            </SettingsPanel>
          )}

          {villageLife && (
            <SettingsPanel
              id={settingsPanelId(VISITORS_TAB)}
              active={activeTab === VISITORS_TAB}
            >
              <VisitorsSection />
            </SettingsPanel>
          )}

          {hasLocalHost && (
            <LocalDevicePanel
              active={hostTabFor(localDeviceId)}
              form={form}
              setForm={setForm}
            />
          )}

          {devices.map((device) => (
            // Keyed by device: a different machine is a different form,
            // seeded from that device's own config read. Mounted on its
            // first pick, so opening Settings reads no peer's config.
            <MountOnceVisited
              key={device.deviceId}
              visited={hostTabFor(device.deviceId) !== undefined}
            >
              <PeerDeviceSettings
                device={device}
                active={hostTabFor(device.deviceId)}
              />
            </MountOnceVisited>
          ))}

          {hostTab !== undefined && picked === undefined && (
            <div className={PAGE_BODY}>
              <p className="text-sm text-muted-foreground">
                No devices on this account yet.
              </p>
            </div>
          )}
        </div>
      </SettingsEditorRegistryProvider>

      {/* The local save spans several sections, so its failure is shown
          above the footer where every section can see it. Peer saves
          report inside their own section. */}
      {save.error && (
        <div className="px-6 pb-3">
          <ErrorBanner
            message={save.error.message}
            title="Couldn't save settings"
          />
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

// The sidebar's update dot brought the visitor here for a button, so
// land on the section holding it (landOnStagedUpdate picks which).
// Only on arrival, though. A check that finishes while the page is
// open must not yank the visitor out of the section they are editing.
function useStagedUpdateLanding(
  updates: Readonly<Record<string, string>>,
): void {
  const [stagedOnArrival] = useState(updates);
  useEffect(() => {
    landOnStagedUpdate(stagedOnArrival);
  }, [stagedOnArrival]);
}

// The build this hostless client runs, and the changelog measured
// against it.
function ClientVersionSection() {
  const [changelogOpen, setChangelogOpen] = useState(false);
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Web client</SectionHeading>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="font-mono text-sm select-text">
          <BuildVersionLine />
        </div>
        <ChangelogButton
          icon={ScrollText}
          label="Changelog"
          onOpen={() => setChangelogOpen(true)}
        />
      </div>
      {changelogOpen && (
        <ChangelogDialog
          installed={__APP_VERSION__}
          staged={null}
          onClose={() => setChangelogOpen(false)}
        />
      )}
    </section>
  );
}

// The device tab bar leading a host section's header: one tab per
// machine (useDeviceRoster's order, this one first), picked for every
// host section and Tidy at once. On the General section, where each
// device's update button lives (`updates` given), a device holding a
// staged update carries the sidebar dot's mark, and Update all trails
// the row: it acts on every tab at once, so it sits with them rather
// than in any one device's panel.
function HostTabBar({
  roster,
  picked,
  updates,
}: {
  roster: readonly DeviceRosterEntry[];
  picked: string;
  // useStagedUpdates' answer, on the General section only.
  updates: Readonly<Record<string, string>> | undefined;
}) {
  const { outdated } = useOutdatedDevices();
  return (
    <DeviceTabBar
      tabs={roster.map((entry) => {
        const version = updates?.[entry.deviceId];
        return {
          ...entry,
          badge: version !== undefined && <UpdateMark version={version} />,
        };
      })}
      selectedId={picked}
      onSelect={pickHostDevice}
      trailing={
        updates && offersUpdateAll(outdated) ? (
          <UpdateAllButton outdated={outdated} />
        ) : undefined
      }
    />
  );
}

// The header names the section the sidebar picked, the way a
// sidebar-driven settings window does, so the pane never has to repeat
// the list. Which machine a host section shows is the tab bar's to
// say. A section that is a room of its own (Visitors) also names the
// watermark and the wallpaper (data-doubutsu-page) it wears in place of
// the settings ones.
function headingFor(activeTab: SettingsTab): {
  eyebrow: string;
  title: string;
  watermark?: string;
  page?: string;
} {
  if (activeTab === VISITORS_TAB) {
    return {
      eyebrow: "Village life",
      title: "Visitors",
      watermark: "来客",
      page: "visitors",
    };
  }
  return {
    eyebrow: "Settings",
    title: SECTION_LABELS[activeTab],
  };
}
