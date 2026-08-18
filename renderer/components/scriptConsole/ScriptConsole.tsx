import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { DiffNotFound } from "@/components/diff/DiffNotFound";
import { WorktreeMissing } from "@/components/diff/WorktreeMissing";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { paramToSlot } from "@/store/scriptRuns";
import { ScriptConsoleInner } from "./ScriptConsoleInner";

const route = getRouteApi(
  "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
);

export function ScriptConsole() {
  const { projectId, worktreeId, scriptKey: rawKey } = route.useParams();
  const navigate = useNavigate();
  const {
    data: worktrees = [],
    isPending,
    isError,
    refetch,
  } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);
  const slot = paramToSlot(rawKey);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId, worktreeId },
    });

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
