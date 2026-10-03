// The Launch section as drawn (LaunchSection.tsx decides whether it
// shows and with which rows): the tool row (LauncherRowView) over the
// script row (ScriptLaunchRowView), or skeletons while a peer's
// scripts load.
import type { ReactNode } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";

export function LaunchSectionView({
  launchers,
  scripts,
  scriptsLoading = false,
}: {
  // Only this machine's own worktrees have tools to launch.
  launchers?: ReactNode;
  scripts: ReactNode;
  scriptsLoading?: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading>Launch</SectionHeading>
      {/* The two rows are one wrapping group of pills, so they sit a
          pill-gap apart, not the section's heading-to-content gap. */}
      <div className="space-y-2">
        {launchers}
        {/* Only a peer's page waits on the scripts: holding the heading
            there keeps the section from popping in above the rest. */}
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
