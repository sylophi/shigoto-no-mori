import type { Dispatch, SetStateAction } from "react";
import type { SettingsFormState } from "@shigomori/ui/lib/settingsForm.ts";
import { useDetectedLaunchers } from "@/hooks/launchers/useLaunchers";
import { LaunchToolsPanelView } from "@shigomori/ui/views/settings/LaunchToolsPanelView.tsx";

// The Launch tools tab (LaunchToolsPanelView) over the tools this
// machine detected.
export function LaunchToolsPanel(props: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  const { data: detected = [] } = useDetectedLaunchers();
  return <LaunchToolsPanelView {...props} detected={detected} />;
}
