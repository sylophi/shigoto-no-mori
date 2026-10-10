import { PageHeaderView } from "@/components/shared/PageHeaderView";
import { Skeleton } from "@/components/ui/skeleton";

export function SettingsSkeletonView() {
  return (
    <div className="flex flex-col gap-8 p-6 phone:p-4">
      <Skeleton className="h-4 w-80" />
      <div className="space-y-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

// The Settings page while its configs load: the header, and the
// skeleton under it.
export function SettingsLoadingView() {
  return (
    <div data-doubutsu-page="settings" className="flex h-full flex-col">
      <PageHeaderView
        eyebrow="Shigoto no Mori"
        title="Settings"
        watermark="設定"
      />
      <SettingsSkeletonView />
    </div>
  );
}
