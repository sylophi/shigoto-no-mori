import { PageHeader } from "@/components/shared/PageHeader";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { SettingsForm } from "./SettingsForm";
import { SettingsTakeover } from "./SettingsSidebarNav";
import { SettingsSkeleton } from "./SettingsSkeleton";

// The page picks its sections from the app sidebar: while this route is
// open, SettingsSidebarNav takes the project tree's place there
// (SidebarTakeover, desktop and web alike), from the first frame, the
// skeleton's included.
export function Settings() {
  return (
    <>
      <SettingsTakeover />
      <SettingsBody />
    </>
  );
}

// A hostless client has no local device config (useGlobalConfig never
// reads one there), so the form seeds the local sections from defaults
// it never shows.
function SettingsBody() {
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
