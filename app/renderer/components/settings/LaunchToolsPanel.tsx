import type { Dispatch, SetStateAction } from "react";
import type { DeviceFormState } from "@shigomori/ui/lib/settingsForm.ts";
import { useDetectedLaunchers } from "@/hooks/launchers/useLaunchers";
import { LaunchToolsPanelView } from "@shigomori/ui/views/settings/LaunchToolsPanelView.tsx";

// The Launch tools tab (LaunchToolsPanelView) over the tools this
// machine detected.
export function LaunchToolsPanel(props: {
  form: DeviceFormState;
  setForm: Dispatch<SetStateAction<DeviceFormState>>;
}) {
  const { data: detected = [] } = useDetectedLaunchers();
  return <LaunchToolsPanelView {...props} detected={detected} />;
}
