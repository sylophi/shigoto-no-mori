import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { SettingsForm } from "./SettingsForm";
import { SettingsSkeleton } from "./SettingsSkeleton";

export function Settings() {
  const { data: config, isLoading } = useGlobalConfig();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">Shigoto no Mori</span>
          <h1 className="text-lg font-medium tracking-tight">Settings</h1>
        </div>
      </header>
      {isLoading ? (
        <SettingsSkeleton />
      ) : (
        <SettingsForm initialConfig={config ?? {}} />
      )}
    </div>
  );
}
