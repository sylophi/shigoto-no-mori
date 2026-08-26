import { PageHeader } from "@/components/shared/PageHeader";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { SettingsForm } from "./SettingsForm";
import { SettingsSkeleton } from "./SettingsSkeleton";

export function Settings() {
  const { data: config, isLoading } = useGlobalConfig();
  const { data: clientConfig, isLoading: isClientLoading } = useClientConfig();

  return (
    <div data-doubutsu-page="settings" className="flex h-full flex-col">
      <PageHeader eyebrow="Shigoto no Mori" title="Settings" watermark="設定" />
      {isLoading || isClientLoading ? (
        <SettingsSkeleton />
      ) : (
        <SettingsForm
          initialConfig={config ?? {}}
          initialClientConfig={clientConfig ?? {}}
        />
      )}
    </div>
  );
}
