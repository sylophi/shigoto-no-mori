import { SubPageNotFound } from "@/components/shared/SubPageNotFound";
import { WorktreeMissing } from "@/components/shared/WorktreeMissing";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { paramToSlot } from "@/store/scriptRuns";
import { ScriptConsoleInner } from "./ScriptConsoleInner";

// A script's console. Serves both the local route and its
// /devices/$deviceId twin: the worktree list, the run store behind the
// terminal and the run's PTY all come from the surrounding host scope.
export function ScriptConsole() {
  const { scriptKey, worktree, goBack, missing } = useRouteWorktree();
  const slot = paramToSlot(scriptKey);

  if (!worktree) {
    return <WorktreeMissing {...missing} message="Script not found." />;
  }
  if (!slot) {
    return <SubPageNotFound onBack={goBack} message="Script not found." />;
  }

  return <ScriptConsoleInner worktree={worktree} slot={slot} onBack={goBack} />;
}
