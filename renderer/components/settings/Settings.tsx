import { PageHeader } from "@/components/shared/PageHeader";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { SettingsForm } from "./SettingsForm";
import { SettingsSkeleton } from "./SettingsSkeleton";

// The page picks its sections from the app sidebar: while this route is
// open, Sidebar renders SettingsSidebarNav in place of the project tree.
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
