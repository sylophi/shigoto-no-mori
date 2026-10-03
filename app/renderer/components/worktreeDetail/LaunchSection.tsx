import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import type { Worktree } from "@shared/schemas";
import { LauncherRow } from "./LauncherRow";
import { LaunchSectionView } from "./LaunchSectionView";
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
    <LaunchSectionView
      launchers={!remote && <LauncherRow worktree={worktree} />}
      scriptsLoading={remote && loading}
      scripts={
        <ScriptLaunchRow
          worktree={worktree}
          candidates={candidates}
          pinned={pinned}
        />
      }
    />
  );
}
