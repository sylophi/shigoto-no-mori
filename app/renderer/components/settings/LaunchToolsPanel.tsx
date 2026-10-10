import type { Dispatch, SetStateAction } from "react";
import type { SettingsFormState } from "@/hooks/config/settingsForm";
import { useDetectedLaunchers } from "@/hooks/launchers/useLaunchers";
import { LaunchToolsPanelView } from "./LaunchToolsPanelView";

// The Launch tools tab (LaunchToolsPanelView) over the tools this
// machine detected.
export function LaunchToolsPanel(props: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  const { data: detected = [] } = useDetectedLaunchers();
  return <LaunchToolsPanelView {...props} detected={detected} />;
}
