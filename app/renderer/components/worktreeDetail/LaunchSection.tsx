import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import type { Worktree } from "@shared/schemas";
import { LauncherRow } from "./LauncherRow";
import { ScriptLaunchRow, useScriptLaunchCandidates } from "./ScriptLaunchRow";

interface LaunchSectionProps {
  worktree: Worktree;
}

export function LaunchSection({ worktree }: LaunchSectionProps) {
  const { remote } = useHostScope();
  const { canCommand } = useCommandAccess();
  const { candidates, loading, pinned } = useScriptLaunchCandidates(worktree);

  // Launching opens editors and shells on the machine showing this window.
  // On another device's worktree there is nothing honest to launch, so the
  // tool row only exists locally. The script pills run on the worktree's own
  // device like the Scripts section does, so they show either way. That
  // leaves a peer's page with no section once the scripts resolve to none,
  // or when it is a read-only mirror and every pill would sit disabled.
  if (remote && (!canCommand || (candidates.length === 0 && !loading))) {
    return null;
  }

  return (
    <section className="space-y-3">
      <SectionHeading>Launch</SectionHeading>
      {/* The two rows are one wrapping group of pills, so they sit a
          pill-gap apart, not the section's heading-to-content gap. */}
      <div className="space-y-2">
        {!remote && <LauncherRow worktree={worktree} />}
        {/* Only a peer's page waits on the scripts: holding the heading
            there keeps the section from popping in above the rest. */}
        {remote && loading ? (
          <div className="flex items-center gap-2" aria-label="Loading scripts">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        ) : (
          <ScriptLaunchRow
            worktree={worktree}
            candidates={candidates}
            pinned={pinned}
          />
        )}
      </div>
    </section>
  );
}
