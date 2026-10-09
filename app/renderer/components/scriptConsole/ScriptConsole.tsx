import { SubPageNotFoundView } from "@/components/shared/SubPageNotFoundView";
import { WorktreeMissingView } from "@/components/shared/WorktreeMissingView";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { paramToSlot } from "@/store/scriptRuns";
import { ScriptConsoleInner } from "./ScriptConsoleInner";

// A script's console, on any device: the worktree list, the run store
// behind the terminal and the run's PTY all come from the surrounding
// host scope.
export function ScriptConsole() {
  const { scriptKey, worktree, goBack, missing } = useRouteWorktree();
  const slot = paramToSlot(scriptKey);

  if (!worktree) {
    return <WorktreeMissingView {...missing} message="Script not found." />;
  }
  if (!slot) {
    return <SubPageNotFoundView onBack={goBack} message="Script not found." />;
  }

  return <ScriptConsoleInner worktree={worktree} slot={slot} onBack={goBack} />;
}
