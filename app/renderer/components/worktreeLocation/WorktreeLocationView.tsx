import type { ReactNode } from "react";
import { Skeleton } from "@shigomori/ui/primitives/skeleton.tsx";
import { PAGE_BODY } from "@shigomori/ui/views/shared/PageShellView.tsx";

// The one scroll box every state of the page renders into.
export function LocationPaneView({ children }: { children: ReactNode }) {
  return (
    <div className={PAGE_BODY}>
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}

export function LocationSkeletonView() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full" />
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}
