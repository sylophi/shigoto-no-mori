// The Settings page over the fixtures: Studio Mac's General section
// with an update staged, the Appearance section with Village life on,
// the other sections and states, and the health check and changelog
// dialogs.
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { DeviceTabBarView } from "@/components/shared/DeviceTabBarView";
import { EditorFooterView } from "@/components/shared/EditorFooterView";
import { SidebarTakeoverView } from "@/components/sidebar/SidebarTakeoverView";
import { ModalBox } from "@shigomori/ui/primitives/modal-shell.tsx";
import { AgentsSectionView } from "@/components/settings/AgentsSectionView";
import { AppearanceSectionView } from "@/components/settings/AppearanceSectionView";
import { ChangelogDialogView } from "@/components/settings/ChangelogDialogView";
import {
  CliSectionView,
  PeerReadErrorView,
  ShellIntegrationView,
} from "@/components/settings/CliSectionView";
import { DangerZoneView } from "@/components/settings/DangerZoneView";
import { DataLocationSectionView } from "@/components/settings/DataLocationSectionView";
import {
  IntegrationTogglesView,
  WorktreeTogglesView,
} from "@/components/settings/DeviceSettingsSectionsView";
import { DoctorDialogView } from "@/components/settings/DoctorDialogView";
import { DoctorSectionView } from "@/components/settings/DoctorSectionView";
import { LaunchToolsPanelView } from "@/components/settings/LaunchToolsPanelView";
import { NotificationsSectionView } from "@/components/settings/NotificationsSectionView";
import {
  PeerOfflineNoteView,
  PeerReadOnlyNoteView,
  PeerSettingsLoadingView,
  PeerTogglesView,
  PeerVersionLineView,
} from "@/components/settings/PeerDeviceSettingsView";
import {
  ClientVersionSectionView,
  NoDevicesView,
  type SettingsHeading,
  SettingsPageView,
} from "@/components/settings/SettingsFormView";
import {
  SettingsSectionChipsView,
  SettingsSidebarNavView,
} from "@/components/settings/SettingsNavView";
import { SettingsPanelView } from "@/components/settings/SettingsPanelView";
import {
  ACCOUNT_SECTION,
  APPEARANCE_TAB,
  GENERAL_TAB,
  settingsPanelId,
  settingsSections,
  TIDY_SECTION,
} from "@/components/settings/settingsSections";
import {
  SettingsLoadingView,
  SettingsSkeletonView,
} from "@/components/settings/SettingsSkeletonView";
import { SidebarSectionView } from "@/components/settings/SidebarSectionView";
import { ThemePickerView } from "@/components/settings/ThemePickerView";
import { UpdateAllButtonView } from "@/components/settings/UpdateAllButtonView";
import { UpdaterStatusLineView } from "@/components/settings/UpdaterStatusLineView";
import { VillageLifeSettingView } from "@/components/settings/VillageLifeSettingView";
import { VillagerDataControlView } from "@/components/settings/VillagerDataControlView";
import {
  villageLifeRow,
  villagerDataView,
} from "@/components/settings/villagerDataView";
import {
  BuildVersionLineView,
  RestartToUpdateButtonView,
  VersionSectionView,
} from "@/components/settings/VersionSectionView";
import { WorktreePrefixesSectionView } from "@/components/settings/WorktreePrefixesSectionView";
import {
  fromConfig,
  type SettingsFormState,
} from "@/hooks/config/settingsForm";
import { DARK_THEMES, LIGHT_THEMES } from "@shared/themes";
import {
  fakeGlobalConfig,
  fakeReleases,
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
} from "../fake-host/fixtures";
import {
  FAKE_DETECTED,
  FAKE_DOCTOR_REPORT,
  fakeAgentHarnesses,
  fakeCliStatus,
  fakeShellStatus,
} from "../fake-host/settingsFixtures";
import { SceneWindowFrame } from "./frame";
import { SceneSidebar } from "./sidebar";
import { deviceById, deviceTabs } from "./world";

const noop = () => {};
const HOME = "/Users/rin";
const VERSION = "2.0.3";
const COMMIT = "fake-host";
const FORM: SettingsFormState = fromConfig(fakeGlobalConfig, {
  theme: "system",
  doubutsu: true,
  villageLife: true,
});
const setForm: Dispatch<SetStateAction<SettingsFormState>> = noop;
const SECTIONS = settingsSections(true, true, true);
const STAGED = {
  kind: "ready",
  version: "2.1.0",
  releaseDate: null,
} as const;

// The sidebar with the Settings list in place of the forest.
export function settingsSidebar(activeId: string) {
  return (
    <SceneSidebar
      view="inbox"
      takeover={
        <SidebarTakeoverView back={{ label: "Back", onClick: noop }}>
          <SettingsSidebarNavView
            sections={SECTIONS}
            activeId={activeId}
            controls={(id) => settingsPanelId(id)}
            onSelect={noop}
            account={{
              section: ACCOUNT_SECTION,
              active: false,
              onSelect: noop,
            }}
            tidy={{ section: TIDY_SECTION, active: false, onSelect: noop }}
          />
        </SidebarTakeoverView>
      }
    />
  );
}

function page(
  heading: SettingsHeading,
  tab: string,
  tabs: ReactNode,
  children: ReactNode,
) {
  return (
    <SettingsPageView
      heading={heading}
      tabs={tabs}
      chips={null}
      saveError={null}
      footer={
        <EditorFooterView
          isDirty={false}
          isPending={false}
          isSuccess={false}
          onDiscard={noop}
          onSave={noop}
        />
      }
    >
      <SettingsPanelView id={settingsPanelId(tab)} active>
        {children}
      </SettingsPanelView>
    </SettingsPageView>
  );
}

function versionSection() {
  return (
    <VersionSectionView
      version={<BuildVersionLineView version={VERSION} commit={COMMIT} />}
      canCommand
      state={STAGED}
      isError={false}
      onRetry={noop}
      onCheck={noop}
      onOpenChangelog={noop}
      restart={
        <RestartToUpdateButtonView
          version={STAGED.version}
          remote={false}
          canCommand
          armed={false}
          pending={false}
          onClick={noop}
        />
      }
      changelog={null}
    />
  );
}

// Studio Mac's General section, an update staged and Update all
// offered across the devices behind.
export function SettingsGeneralScene() {
  return (
    <SceneWindowFrame
      sidebar={settingsSidebar(GENERAL_TAB)}
      pathname="/settings"
    >
      {page(
        { eyebrow: "Settings", title: "General" },
        GENERAL_TAB,
        <DeviceTabBarView
          tabs={deviceTabs([LOCAL_DEVICE_ID, THINKPAD_ID, MINI_ID])}
          selectedId={LOCAL_DEVICE_ID}
          onSelect={noop}
          trailing={
            <UpdateAllButtonView armed={false} pending={false} onClick={noop} />
          }
        />,
        <>
          {versionSection()}
          <DoctorSectionView
            remote={false}
            report={FAKE_DOCTOR_REPORT}
            checkedAt={Date.now() - 3 * 3_600_000}
            onRun={noop}
            dialog={null}
          />
          <CliSectionView
            status={fakeCliStatus(HOME)}
            home={HOME}
            busy={false}
            onInstall={noop}
            onUninstall={noop}
            shell={
              <ShellIntegrationView
                name="sm"
                status={fakeShellStatus(HOME)}
                home={HOME}
                busy={false}
                onEnable={noop}
                onRemove={noop}
                changed={false}
              />
            }
          />
          <DataLocationSectionView
            remote={false}
            root={`${HOME}/.sm`}
            home={HOME}
            moving={false}
            busy={false}
            movable
            atDefault
            resetArmed={false}
            onReveal={noop}
            onPickParent={noop}
            onReset={noop}
            picker={null}
          />
          <DangerZoneView
            root="~/.sm"
            nuking={false}
            progress={null}
            armed={false}
            onNuke={noop}
          />
        </>,
      )}
    </SceneWindowFrame>
  );
}

const villagerData = villagerDataView({
  kind: "ready",
  downloadedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
  villagers: 488,
});

// The Appearance section, doubutsu and Village life on.
export function SettingsAppearanceScene() {
  return (
    <SceneWindowFrame
      sidebar={settingsSidebar(APPEARANCE_TAB)}
      pathname="/settings"
    >
      {page(
        { eyebrow: "Settings", title: "Appearance" },
        APPEARANCE_TAB,
        null,
        <>
          <AppearanceSectionView
            heading="Theme"
            theme={FORM.theme}
            onPick={noop}
            doubutsu
            onDoubutsuChange={noop}
            pauseAnimationsOnBattery
            onPauseAnimationsOnBatteryChange={noop}
            battery
            lightPalette={
              <ThemePickerView
                appearance="light"
                options={LIGHT_THEMES}
                value={FORM.lightTheme}
                saved={FORM.lightTheme}
                onChange={noop}
              />
            }
            darkPalette={
              <ThemePickerView
                appearance="dark"
                options={DARK_THEMES}
                value={FORM.darkTheme}
                saved={FORM.darkTheme}
                onChange={noop}
              />
            }
            villageLife={
              <VillageLifeSettingView
                view={villageLifeRow({
                  kind: "ready",
                  downloadedAt: new Date().toISOString(),
                  villagers: 488,
                })}
                shows
                onVillageLifeChange={noop}
                villageNews
                onVillageNewsChange={noop}
                dataControl={
                  <VillagerDataControlView
                    view={villagerData}
                    armed={false}
                    removePending={false}
                    disabled={false}
                    onRemove={noop}
                    onAction={noop}
                  />
                }
              />
            }
          />
          <SidebarSectionView
            form={FORM}
            setForm={setForm}
            signedIn
            terrierOn
          />
          <NotificationsSectionView form={FORM} setForm={setForm} />
          <WorktreePrefixesSectionView
            list="hidden"
            prefixes={["exp/", "tmp-"]}
            settled
            commit={() => true}
          />
          <WorktreePrefixesSectionView
            list="grouped"
            prefixes={["v3/"]}
            settled
            commit={() => true}
          />
        </>,
      )}
    </SceneWindowFrame>
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

// The other sections, and a peer's in its states: not reached yet,
// read-only, loading, and its CLI read refused. The phone layout's
// section chips, and the page while its configs load.
export function SettingsPartsScene() {
  const thinkpad = deviceById(THINKPAD_ID);
  return (
    <div className="grid h-full grid-cols-2 gap-8 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex min-w-0 flex-col gap-8">
        <Part label="Launch tools">
          <LaunchToolsPanelView
            form={FORM}
            setForm={setForm}
            detected={FAKE_DETECTED}
          />
        </Part>
        <Part label="Agents">
          <AgentsSectionView
            harnesses={fakeAgentHarnesses(HOME)}
            home={HOME}
            busy={false}
            onSetHooks={noop}
          />
        </Part>
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <Part label="Worktrees and integrations, a peer read-only">
          <PeerTogglesView
            readOnly
            note={<PeerReadOnlyNoteView label={thinkpad.label} />}
            saveError={null}
          >
            <WorktreeTogglesView
              form={FORM}
              setForm={setForm}
              driveBase="/Volumes/<drive>/.sm/worktrees/<project>"
            />
          </PeerTogglesView>
          <IntegrationTogglesView
            form={FORM}
            setForm={setForm}
            readiness={{
              portPoolInstalled: false,
              terrierInstalled: true,
              terrierReadable: false,
              ghInstalled: true,
              ghAuthed: false,
            }}
          />
        </Part>
        <Part label="A peer's General section">
          <PeerOfflineNoteView label="Mini" dialing={false} />
          <PeerOfflineNoteView label={thinkpad.label} dialing />
          <PeerSettingsLoadingView />
          <PeerVersionLineView appVersion="" />
          <PeerReadErrorView
            what="the CLI install"
            message="the device closed the connection"
            heading
          />
          <NoDevicesView />
          <ClientVersionSectionView
            version={VERSION}
            commit={COMMIT}
            onOpenChangelog={noop}
            changelog={null}
          />
          <UpdaterStatusLineView state={{ kind: "checking" }} />
        </Part>
        <Part label="Phone">
          <SettingsSectionChipsView
            sections={SECTIONS}
            activeId={GENERAL_TAB}
            controls={(id) => settingsPanelId(id)}
            onSelect={noop}
          />
          <div className="h-64 overflow-hidden rounded-lg border border-border">
            <SettingsLoadingView />
          </div>
          <SettingsSkeletonView />
        </Part>
      </div>
    </div>
  );
}

// The health check with two problems, one repairable, and the update's
// news.
export function SettingsDialogsScene() {
  return (
    <div className="grid h-full grid-cols-2 items-start gap-6 overflow-hidden bg-background p-6 text-foreground">
      <ModalBox className="max-w-2xl">
        <DoctorDialogView
          title="Health check"
          report={FAKE_DOCTOR_REPORT}
          error={null}
          isFetching={false}
          repairing={false}
          repairError={undefined}
          armed={false}
          onRepair={noop}
          onCheckAgain={noop}
          onClose={noop}
        />
      </ModalBox>
      <ModalBox className="max-w-2xl">
        <ChangelogDialogView
          installed={VERSION}
          staged={{ version: STAGED.version }}
          restartButton={
            <RestartToUpdateButtonView
              version={STAGED.version}
              remote={false}
              canCommand
              armed={false}
              pending={false}
              onClick={noop}
            />
          }
          releases={{
            data: fakeReleases,
            isError: false,
            error: null,
            onRetry: noop,
          }}
          onClose={noop}
        />
      </ModalBox>
    </div>
  );
}
