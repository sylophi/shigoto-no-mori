import type { Dispatch, SetStateAction } from "react";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { CliSection } from "./CliSection";
import { DangerZone } from "./DangerZone";
import { DataLocationSection } from "./DataLocationSection";
import { DeviceToggleSections } from "./DeviceSettingsSections";
import { VersionSection } from "./VersionSection";

// This machine's section. The same version and toggle sections every
// peer section renders, plus the three that only exist for the
// machine the window runs on: they act on this disk and this shell (CLI
// links, the data root, the nuke), so no peer section offers them.
export function LocalDevicePanel({
  form,
  setForm,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  return (
    <>
      <VersionSection
        version={
          <>
            {__APP_VERSION__}{" "}
            <span className="text-muted-foreground">({__APP_COMMIT__})</span>
          </>
        }
      />

      <DeviceToggleSections form={form} setForm={setForm} />

      <CliSection />

      <DataLocationSection />

      <DangerZone />
    </>
  );
}
