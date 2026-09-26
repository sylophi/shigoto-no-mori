import type { Dispatch, SetStateAction } from "react";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { CliSection } from "./CliSection";
import { DangerZone } from "./DangerZone";
import { DataLocationSection } from "./DataLocationSection";
import { DoctorSection } from "./DoctorSection";
import { DeviceToggleSections } from "./DeviceSettingsSections";
import { BuildVersionLine, VersionSection } from "./VersionSection";

// This machine's section: the sections a peer section renders too
// (some only while that peer allows control), plus the danger zone,
// which only exists for the machine the window runs on (no peer
// section offers the nuke).
export function LocalDevicePanel({
  form,
  setForm,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  return (
    <>
      <VersionSection version={<BuildVersionLine />} />

      <DoctorSection />

      <DeviceToggleSections form={form} setForm={setForm} />

      <CliSection />

      <DataLocationSection />

      <DangerZone />
    </>
  );
}
