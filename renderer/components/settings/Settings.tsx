import { PageHeader } from "@/components/shared/PageHeader";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { SettingsForm } from "./SettingsForm";
import { SettingsSkeleton } from "./SettingsSkeleton";

// The page picks its sections from the app sidebar: while this route is
// open, the sidebar (desktop and web alike) renders SettingsSidebarNav
// in place of the project tree. A hostless client has no local device
// config (useGlobalConfig never reads one there), so the form seeds the
// local sections from defaults it never shows.
export function Settings() {
  const { data: config, isLoading } = useGlobalConfig();
  const { data: clientConfig, isLoading: isClientLoading } = useClientConfig();

  if (isLoading || isClientLoading) {
    return (
      <div data-doubutsu-page="settings" className="flex h-full flex-col">
        <PageHeader
          eyebrow="Shigoto no Mori"
          title="Settings"
          watermark="設定"
        />
        <SettingsSkeleton />
      </div>
    );
  }

  return (
    <SettingsForm
      initialConfig={config ?? {}}
      initialClientConfig={clientConfig ?? {}}
    />
  );
}
