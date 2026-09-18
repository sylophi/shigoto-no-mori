import type { Dispatch, SetStateAction } from "react";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { CliSection } from "./CliSection";
import { DangerZone } from "./DangerZone";
import { DataLocationSection } from "./DataLocationSection";
import { DeviceToggleSections } from "./DeviceSettingsSections";
import { BuildVersionLine, VersionSection } from "./VersionSection";

// This machine's section: the version, toggle, CLI and data location
// sections a peer section renders too (the last two only while that
// peer allows control), plus the danger zone, which only exists for
// the machine the window runs on (no peer section offers the nuke).
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

      <DeviceToggleSections form={form} setForm={setForm} />

      <CliSection />

      <DataLocationSection />

      <DangerZone />
    </>
  );
}
