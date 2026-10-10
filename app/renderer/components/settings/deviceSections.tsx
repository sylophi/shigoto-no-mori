import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { SettingsFormState } from "@shigomori/ui/lib/settingsForm.ts";
import { DeviceTogglesView } from "@shigomori/ui/views/settings/PeerDeviceSettingsView.tsx";
import { AgentsSection } from "./AgentsSection";
import { CliSection } from "./CliSection";
import { DangerZone } from "./DangerZone";
import { DataLocationSection } from "./DataLocationSection";
import { DoctorSection } from "./DoctorSection";
import { IntegrationToggles, WorktreeToggles } from "./DeviceSettingsSections";
import type { HostSections } from "./SettingsPanel";

// What one device shows on its host sections, this machine's or a
// peer's: the same sections over that device's form, differing only in what the device
// lets this window do. The sections that read its disk (the health
// check, the CLI, the data location, the agents) show once it takes
// commands from here, since a device only names its paths to a peer it
// lets command it; until then `note` says why. The danger zone is for
// whoever sits at the machine, so only this one's General has it.
export function deviceSections({
  form,
  setForm,
  version,
  commands,
  readOnly = false,
  note = null,
  saveError = null,
  dangerZone = false,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
  // The Version section, at the head of General.
  version: ReactNode;
  commands: boolean;
  // Toggles frozen: the device can be read but not commanded.
  readOnly?: boolean;
  note?: ReactNode;
  saveError?: ReactNode;
  dangerZone?: boolean;
}): HostSections {
  const toggles = (children: ReactNode) => (
    <DeviceTogglesView readOnly={readOnly} note={note} saveError={saveError}>
      {children}
    </DeviceTogglesView>
  );
  return {
    general: (
      <>
        {version}
        {commands ? (
          <>
            <DoctorSection />
            <CliSection />
            <DataLocationSection />
          </>
        ) : (
          note
        )}
        {dangerZone && <DangerZone />}
      </>
    ),
    worktrees: toggles(<WorktreeToggles form={form} setForm={setForm} />),
    integrations: (
      <>
        {toggles(<IntegrationToggles form={form} setForm={setForm} />)}
        {commands && <AgentsSection />}
      </>
    ),
  };
}
