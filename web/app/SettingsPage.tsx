// "/settings" on the web: this browser's preferences, wearing the
// desktop Settings page's chrome (PageShell, the "settings" wallpaper
// zone). Appearance reuses the desktop's AppearanceSection over the
// same clientConfig store (backed by localStorage through the bridge).
// Saves are immediate rather than staged behind the desktop's
// multi-store Save button: appearance is the only web-managed setting,
// and the write path still goes through mergeClientConfigWrite so
// out-of-band client keys survive.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ClientConfig, Theme } from "@shared/schemas";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { PageShell } from "@/components/shared/PageShell";
import { SectionHeading } from "@/components/ui/section-heading";
import { mergeClientConfigWrite } from "@/hooks/config/mergeClientConfigWrite";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useTheme } from "@/hooks/ui/useTheme";
import { queryKeys } from "@/lib/queryKeys";

export function SettingsPage() {
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
    <PageShell
      page="settings"
      eyebrow="This browser"
      title="Settings"
      watermark="設定"
    >
      {/* Prose-shaped, so it caps its own width where Devices runs full. */}
      <div className="flex max-w-3xl flex-col gap-10">
        <AppearanceSection
          theme={theme.applied}
          onPick={onPickTheme}
          doubutsu={doubutsu.applied}
          onDoubutsuChange={onDoubutsuChange}
        />
        <section className="space-y-1">
          <SectionHeading>About</SectionHeading>
          <p className="text-xs text-muted-foreground">
            Shigoto no Mori web client{" "}
            <span className="font-mono">{window.api.appVersion}</span>
          </p>
        </section>
      </div>
    </PageShell>
  );
}
