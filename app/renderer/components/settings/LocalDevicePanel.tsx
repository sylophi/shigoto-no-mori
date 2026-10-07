import type { Dispatch, SetStateAction } from "react";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { localDeviceId } from "@/lib/queryKeys";
import { CliSection } from "./CliSection";
import { DangerZone } from "./DangerZone";
import { DataLocationSection } from "./DataLocationSection";
import { DoctorSection } from "./DoctorSection";
import { IntegrationToggles, WorktreeToggles } from "./DeviceSettingsSections";
import { HostPanels } from "./SettingsPanel";
import type { HostTab } from "./settingsNav";
import { BuildVersionLine, VersionSection } from "./VersionSection";

// This machine's host sections: the sections a peer's renders too
// (some only while that peer allows control), plus the danger zone,
// which only exists for the machine the window runs on (no peer's
// General section offers the nuke).
export function LocalDevicePanel({
  active,
  form,
  setForm,
}: {
  active: HostTab | undefined;
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  return (
    <HostPanels
      deviceId={localDeviceId}
      active={active}
      sections={{
        general: (
          <>
            <VersionSection
              version={<BuildVersionLine />}
              installed={__APP_VERSION__}
            />
            <DoctorSection />
            <CliSection />
            <DataLocationSection />
            <DangerZone />
          </>
        ),
        worktrees: <WorktreeToggles form={form} setForm={setForm} />,
        integrations: <IntegrationToggles form={form} setForm={setForm} />,
      }}
    />
  );
}
