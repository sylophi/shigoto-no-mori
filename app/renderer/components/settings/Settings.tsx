import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { SettingsForm } from "./SettingsForm";
import { SettingsLoadingView } from "@shigomori/ui/views/settings/SettingsSkeletonView.tsx";

// The page picks its sections from the app sidebar, where its layout
// route (SettingsPages) draws their list. A hostless client has no
// local device config (useGlobalConfig never reads one there), so the
// form seeds the local sections from defaults it never shows.
export function Settings() {
  const { data: config, isLoading } = useGlobalConfig();
  const { data: clientConfig, isLoading: isClientLoading } = useClientConfig();

  if (isLoading || isClientLoading) {
    return <SettingsLoadingView />;
  }

  return (
    <SettingsForm
      initialConfig={config ?? {}}
      initialClientConfig={clientConfig ?? {}}
    />
  );
}
