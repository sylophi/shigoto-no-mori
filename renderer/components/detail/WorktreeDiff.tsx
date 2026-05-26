import { useNavigate } from "@tanstack/react-router";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreeDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { worktreeDiffRoute } from "@/router";
import { DiffNotFound, DiffView } from "./DiffView";

export function WorktreeDiff() {
  const { projectId, worktreeId } = worktreeDiffRoute.useParams();
  const navigate = useNavigate();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId, worktreeId },
    });

  const {
    data: patch,
    isLoading,
    error,
  } = useWorktreeDiff(projectId, worktree?.id);

  if (!worktree) {
    return <DiffNotFound onBack={goBack} message="Worktree not found." />;
  }

  return (
    <DiffView
      patch={patch}
      isLoading={isLoading}
      error={error}
      onBack={goBack}
      backLabel={worktree.branch}
      title="Uncommitted changes"
      subtitle={
        <>
          {worktree.changedCount}{" "}
          {worktree.changedCount === 1 ? "file" : "files"} changed in{" "}
          <span className="font-mono">{worktree.name}</span>
        </>
      }
      emptyMessage="No uncommitted changes."
    />
  );
}
