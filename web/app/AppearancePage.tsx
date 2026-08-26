// Appearance settings for the web client, reusing the desktop's
// AppearanceSection over the same clientConfig store (backed by
// localStorage through the bridge). Saves are immediate rather than
// staged behind the desktop's multi-store Save button: appearance is
// the only web-managed setting, and the write path still goes through
// mergeClientConfigWrite so out-of-band client keys survive.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ClientConfig, Theme } from "@shared/schemas";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { mergeClientConfigWrite } from "@/hooks/config/mergeClientConfigWrite";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useTheme } from "@/hooks/ui/useTheme";
import { queryKeys } from "@/lib/queryKeys";

export function AppearancePage() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const doubutsu = useDoubutsu();

  const save = useMutation({
    mutationFn: (patch: Partial<ClientConfig>) =>
      mergeClientConfigWrite(queryClient, patch),
    onSuccess: (merged) => {
      queryClient.setQueryData(queryKeys.clientConfig(), merged);
    },
    meta: { errorTitle: "Couldn't save appearance settings" },
  });

  // The override paints the choice instantly and clears itself once the
  // saved value catches up (see useTheme/useDoubutsu), so a failed save
  // snaps back instead of lying.
  const onPickTheme = (next: Theme) => {
    theme.setOverride(next);
    save.mutate({ theme: next === "system" ? undefined : next });
  };
  const onDoubutsuChange = (next: boolean) => {
    doubutsu.setOverride(next);
    save.mutate({ doubutsu: next ? undefined : false });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="relative flex items-center gap-3 overflow-hidden border-b border-border px-6 pt-5 pb-4">
        <div className="relative z-[1] flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            This browser
          </span>
          <h1 className="truncate text-lg font-medium tracking-tight">
            Appearance
          </h1>
        </div>
        <span
          aria-hidden
          className="doubutsu-only pointer-events-none absolute -top-6 right-2 text-[120px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-10 select-none"
        >
          設定
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div
          className="flex max-w-3xl flex-col gap-6"
          data-doubutsu-page="settings"
        >
          <AppearanceSection
            theme={theme.applied}
            onPick={onPickTheme}
            doubutsu={doubutsu.applied}
            onDoubutsuChange={onDoubutsuChange}
          />
        </div>
      </div>
    </div>
  );
}
