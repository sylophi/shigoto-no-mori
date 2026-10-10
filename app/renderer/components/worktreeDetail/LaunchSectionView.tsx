// The worktree page's Launch section (LaunchSection binds it): the
// launch tools on this device, and the package.json scripts.
import type { ReactNode } from "react";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { Skeleton } from "@shigomori/ui/primitives/skeleton.tsx";

export function LaunchSectionView({
  tools,
  scripts,
  scriptsLoading = false,
}: {
  // The launch tools (LauncherRow), this device's alone.
  tools?: ReactNode;
  // The scripts' row (ScriptLaunchRow).
  scripts: ReactNode;
  // Only a peer's page waits on the scripts: holding the heading
  // there keeps the section from popping in above the rest.
  scriptsLoading?: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading>Launch</SectionHeading>
      {/* The two rows are one wrapping group of pills, so they sit a
          pill-gap apart, not the section's heading-to-content gap. */}
      <div className="space-y-2">
        {tools}
        {scriptsLoading ? (
          <div className="flex items-center gap-2" aria-label="Loading scripts">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        ) : (
          scripts
        )}
      </div>
    </section>
  );
}
