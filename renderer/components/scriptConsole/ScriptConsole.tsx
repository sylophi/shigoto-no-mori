import { DiffNotFound } from "@/components/diff/DiffNotFound";
import { WorktreeMissing } from "@/components/diff/WorktreeMissing";
import {
  useScopedWorktreeParams,
  useWorktreeNav,
} from "@/hooks/worktrees/useWorktreeNav";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { paramToSlot } from "@/store/scriptRuns";
import { ScriptConsoleInner } from "./ScriptConsoleInner";

// A script's console. Serves both the local route and its
// /devices/$deviceId twin: the worktree list, the run store behind the
// terminal and the run's PTY all come from the surrounding host scope.
export function ScriptConsole() {
  const {
    projectId,
    worktreeId,
    scriptKey: rawKey,
  } = useScopedWorktreeParams();
  const { toWorktree } = useWorktreeNav();
  const {
    data: worktrees = [],
    isPending,
    isError,
    refetch,
  } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);
  const slot = paramToSlot(rawKey);

  const goBack = () => toWorktree(projectId, worktreeId);

  if (!worktree) {
    return (
      <WorktreeMissing
        isPending={isPending}
        isError={isError}
        refetch={refetch}
        onBack={goBack}
        message="Script not found."
      />
    );
  }
  if (!slot) {
    return <DiffNotFound onBack={goBack} message="Script not found." />;
  }

  return <ScriptConsoleInner worktree={worktree} slot={slot} onBack={goBack} />;
}
