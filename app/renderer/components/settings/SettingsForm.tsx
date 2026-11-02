import { useEffect, useEffectEvent, useState } from "react";
import { EditorFooterView } from "@shigomori/ui/views/shared/EditorFooterView.tsx";
import { useSettingsSave } from "@/hooks/config/useSettingsSave";
import {
  type ClientFormState,
  fromClientConfig,
} from "@shigomori/ui/lib/settingsForm.ts";
import {
  pickHostDevice,
  useDeviceRoster,
  useHostDevicePick,
  type DeviceRosterEntry,
} from "@/components/shared/DeviceTabs";
import { DeviceTabBarView } from "@shigomori/ui/views/shared/DeviceTabBarView.tsx";
import { LayoutSectionView } from "@shigomori/ui/views/settings/LayoutSectionView.tsx";
import { resetLayout } from "@/store/layout";
import { UpdateMark } from "@shigomori/ui/primitives/status-dot.tsx";
import { useHostDevices } from "@/hooks/remote/useDevices";
import {
  useOutdatedDevices,
  useStagedUpdates,
} from "@/hooks/system/useUpdater";
import {
  fieldSetter,
  keepTouched,
  useDirtyForm,
} from "@shigomori/ui/hooks/useDirtyForm.ts";
import { useLook } from "@/hooks/ui/useLook";
import { useHasLocalHost } from "@/lib/localHost";
import { holdThemeRotation } from "@/lib/themeRotation";
import type {
  ClientConfig,
  GlobalConfig,
  Theme,
} from "@shigomori/contracts/schemas";
import {
  type DarkTheme,
  darkTwin,
  type LightTheme,
  lightTwin,
} from "@shigomori/ui/lib/themes.ts";
import { AppearanceSection } from "./AppearanceSection";
import { WorktreePrefixesSection } from "./WorktreePrefixesSection";
import { LaunchToolsPanel } from "./LaunchToolsPanel";
import { deviceSections } from "./deviceSections";
import { HostPanels } from "./SettingsPanel";
import { VersionSection } from "./VersionSection";
import { BuildVersionLineView } from "@shigomori/ui/views/settings/VersionSectionView.tsx";
import { PeerDeviceSettings } from "./PeerDeviceSettings";
import { SettingsSectionChips } from "./SettingsSectionChips";
import { NotificationsSectionView } from "@shigomori/ui/views/settings/NotificationsSectionView.tsx";
import { KeyboardSection } from "./KeyboardSection";
import { SidebarSection } from "./SidebarSection";
import {
  MountOnceVisited,
  SettingsPanelView,
} from "@shigomori/ui/views/settings/SettingsPanelView.tsx";
import { landOnStagedUpdate, useActiveSettingsTab } from "./settingsNav";
import {
  APPEARANCE_TAB,
  GENERAL_TAB,
  isHostTab,
  KEYBOARD_TAB,
  LAUNCH_TAB,
  settingsPanelId,
  SECTION_LABELS,
  type SettingsTab,
  VISITORS_TAB,
} from "@shigomori/ui/views/settings/settingsSections.ts";
import { offersUpdateAll, UpdateAllButton } from "./UpdateAllButton";
import { VisitorsSection } from "@/components/visitors/VisitorsSection";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import {
  SettingsEditorRegistryProvider,
  useSettingsEditorRegistry,
} from "./useSettingsEditors";
import { useDeviceSettingsForm } from "./useDeviceSettingsForm";
import { ChangelogDialog } from "./ChangelogDialog";
import {
  ClientVersionSectionView,
  NoDevicesView,
  type SettingsHeading,
  SettingsPageView,
} from "@shigomori/ui/views/settings/SettingsFormView.tsx";
import { useApi } from "@/lib/runtime/pageApi";

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
// One form per store: this window's client config backs the
// Appearance and Keyboard sections, and each device's config backs that
// device's host sections (this machine's also backs Launch tools), each
// seeded from that device's config read. Sections mount on first visit
// and stay mounted (SettingsPanelView), so switching section or device
// never drops an edit, and the one footer saves and discards every form
// at once.
//
// A hostless client (the web shell) has no machine behind the window:
// Launch tools and this device's sections are not offered, so this
// device's form is never shown, and every device in the tab bar is a
// peer, edited over that peer's direct session exactly as from another
// desktop.
export function SettingsForm(props: {
  initialConfig: GlobalConfig;
  initialClientConfig: ClientConfig;
}) {
  const editors = useSettingsEditorRegistry();
  return (
    <SettingsEditorRegistryProvider registry={editors.registry}>
      <SettingsPage {...props} editors={editors} />
    </SettingsEditorRegistryProvider>
  );
}

function SettingsPage({
  initialConfig,
  initialClientConfig,
  editors,
}: {
  initialConfig: GlobalConfig;
  initialClientConfig: ClientConfig;
  editors: ReturnType<typeof useSettingsEditorRegistry>;
}) {
  const api = useApi();
  const localDeviceId = api.deviceId;
  const hasLocalHost = useHasLocalHost();
  const save = useSettingsSave();
  const { setOverride } = useLook();
  const peers = useHostDevices().filter((device) => !device.isThisDevice);
  const roster = useDeviceRoster();
  const activeTab = useActiveSettingsTab();
  const hostTab = isHostTab(activeTab) ? activeTab : undefined;
  const picked = useHostDevicePick(roster);
  // The host section a device's panels show: the active one while that
  // device is picked, none otherwise.
  const hostTabFor = (deviceId: string) =>
    picked?.deviceId === deviceId ? hostTab : undefined;
  const villageLife = useVillageLife();

  const seed = fromClientConfig(initialClientConfig);
  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty, reseed } =
    useDirtyForm<ClientFormState>(seed);
  const setField = fieldSetter(setForm);
  // Another window or a hotkey moved a stored setting: the form follows
  // it, keeping the fields changed here unsaved over it.
  const seedJson = JSON.stringify(seed);
  useEffect(() => {
    reseed(JSON.parse(seedJson) as ClientFormState, keepTouched);
  }, [seedJson, reseed]);
  // This machine's form lives here rather than beside its panels, since
  // the Sidebar section reads its staged terrier toggle.
  const deviceForm = useDeviceSettingsForm(localDeviceId, initialConfig);

  // No palette rotation turns behind the form's back.
  useEffect(() => holdThemeRotation(), []);

  // Drop any staged previews when leaving the settings page so the rest
  // of the app falls back to the saved values. On leaving alone,
  // whatever the provider hands out for the setter.
  const dropPreviews = useEffectEvent(() => setOverride(null));
  useEffect(() => () => dropPreviews(), []);

  const handleSave = async () => {
    const saved = savedSnapshot;
    try {
      await save.mutateAsync({ state: form, saved });
      // Only the fields this Save carried advance: a change another window
      // made to another field while it was out stays theirs.
      setSavedSnapshot((prev) => keepTouched(form, saved, prev));
    } catch {
      // The mutation's toast and the banner below surface the failure.
    }
    // No explicit setOverride(null). The provider clears the override
    // automatically once `saved` catches up to the staged value.
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
    save.reset();
    setOverride(null);
  };

  const pickTheme = (theme: Theme) => {
    setForm((prev) => ({ ...prev, theme }));
    setOverride({ theme });
  };

  const setDoubutsu = (next: boolean) => {
    setForm((prev) => ({ ...prev, doubutsu: next }));
    setOverride({ doubutsu: next });
  };

  // A pick previews at once, like the appearance: the light one shows
  // while the window is light, the dark one while it is dark, and
  // the other waits for its appearance. While rotation is on the picks
  // are one pair: either brings its twin along, and turning rotation
  // on pairs the dark pick with the light one.
  const pickPair = (lightTheme: LightTheme, darkTheme: DarkTheme) => {
    setForm((prev) => ({ ...prev, lightTheme, darkTheme }));
    setOverride({ light: lightTheme, dark: darkTheme });
  };
  const pickLightTheme = (lightTheme: LightTheme) => {
    if (form.themeRotation) return pickPair(lightTheme, darkTwin(lightTheme));
    setForm((prev) => ({ ...prev, lightTheme }));
    setOverride({ light: lightTheme });
  };
  const pickDarkTheme = (darkTheme: DarkTheme) => {
    if (form.themeRotation) return pickPair(lightTwin(darkTheme), darkTheme);
    setForm((prev) => ({ ...prev, darkTheme }));
    setOverride({ dark: darkTheme });
  };
  const setThemeRotation = (next: boolean) => {
    setForm((prev) => ({ ...prev, themeRotation: next }));
    if (next) pickPair(form.lightTheme, darkTwin(form.lightTheme));
  };

  // The device forms, as the footer sees them.
  const { summary: deviceForms, saveAll, discardAll } = editors;
  const anyDirty = isDirty || deviceForms.isDirty;
  const anyToSave = isDirty || deviceForms.canSave;
  const anyPending = save.isPending || deviceForms.isPending;
  const anySuccess = save.isSuccess || deviceForms.isSuccess;

  // Each form surfaces its own failure and stays dirty.
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
    <SettingsPageView
      heading={heading}
      tabs={tabs}
      chips={
        <SettingsSectionChips
          activeTab={activeTab}
          update={Object.keys(updates).length > 0}
        />
      }
      saveError={(save.error ?? deviceForm.saveError)?.message ?? null}
      footer={
        <EditorFooterView
          isDirty={anyDirty}
          isPending={anyPending}
          isSuccess={anySuccess}
          canSave={anyToSave}
          onDiscard={handleDiscardAll}
          onSave={() => void handleSaveAll()}
        />
      }
    >
      <SettingsPanelView
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
          themeRotation={form.themeRotation}
          onThemeRotationChange={setThemeRotation}
          themeRotationEvery={form.themeRotationEvery}
          onThemeRotationEveryChange={setField("themeRotationEvery")}
          pauseAnimationsOnBattery={form.pauseAnimationsOnBattery}
          onPauseAnimationsOnBatteryChange={setField(
            "pauseAnimationsOnBattery",
          )}
          darkTerminals={form.darkTerminals}
          onDarkTerminalsChange={setField("darkTerminals")}
          villageLife={form.villageLife}
          onVillageLifeChange={setField("villageLife")}
          villageNews={form.villageNews}
          onVillageNewsChange={setField("villageNews")}
        />
        <SidebarSection
          form={form}
          setForm={setForm}
          terrier={deviceForm.form.terrier}
        />
        {hasLocalHost && (
          <NotificationsSectionView form={form} setForm={setForm} />
        )}
        <WorktreePrefixesSection list="hidden" />
        <WorktreePrefixesSection list="grouped" />
        <LayoutSectionView
          onReset={() => {
            resetLayout();
            if (hasLocalHost) void api.run(api.window.resetLayout());
          }}
        />
        {/* The desktop states its build in this device's General
                section. A hostless client has no such section, and its
                build is still worth a line, so it goes with the other
                setting that is about this window. */}
        {!hasLocalHost && <ClientVersionSection />}
      </SettingsPanelView>

      {hasLocalHost && (
        <SettingsPanelView
          id={settingsPanelId(LAUNCH_TAB)}
          active={activeTab === LAUNCH_TAB}
        >
          <LaunchToolsPanel
            form={deviceForm.form}
            setForm={deviceForm.setForm}
          />
        </SettingsPanelView>
      )}

      <SettingsPanelView
        id={settingsPanelId(KEYBOARD_TAB)}
        active={activeTab === KEYBOARD_TAB}
      >
        <KeyboardSection form={form} setForm={setForm} />
      </SettingsPanelView>

      {villageLife && (
        <SettingsPanelView
          id={settingsPanelId(VISITORS_TAB)}
          active={activeTab === VISITORS_TAB}
        >
          <VisitorsSection />
        </SettingsPanelView>
      )}

      {hasLocalHost && (
        <HostPanels
          deviceId={localDeviceId}
          active={hostTabFor(localDeviceId)}
          sections={deviceSections({
            form: deviceForm.form,
            setForm: deviceForm.setForm,
            version: (
              <VersionSection
                version={
                  <BuildVersionLineView
                    version={__APP_VERSION__}
                    commit={__APP_COMMIT__}
                  />
                }
                installed={__APP_VERSION__}
              />
            ),
            commands: true,
            dangerZone: true,
          })}
        />
      )}

      {peers.map((device) => (
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

      {hostTab !== undefined && picked === undefined && <NoDevicesView />}
    </SettingsPageView>
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
    <ClientVersionSectionView
      version={__APP_VERSION__}
      commit={__APP_COMMIT__}
      onOpenChangelog={() => setChangelogOpen(true)}
      changelog={
        changelogOpen && (
          <ChangelogDialog
            installed={__APP_VERSION__}
            staged={null}
            onClose={() => setChangelogOpen(false)}
          />
        )
      }
    />
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
    <DeviceTabBarView
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
function headingFor(activeTab: SettingsTab): SettingsHeading {
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
