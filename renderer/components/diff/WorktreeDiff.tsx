import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreeDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { DiffNotFound } from "./DiffNotFound";
import { DiffView } from "./DiffView";

const route = getRouteApi("/projects/$projectId/worktrees/$worktreeId/diff");

export function WorktreeDiff() {
  const { projectId, worktreeId } = route.useParams();
  const navigate = useNavigate();
  const {
    data: worktrees = [],
    isPending,
    isError,
    refetch,
  } = useWorktrees(projectId);
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
    // Cold cache (e.g. a reload landing directly on this route): the
    // list hasn't resolved yet, so absence doesn't mean missing.
    if (isPending) return null;
    // The list query is silent on error, so without this branch a
    // failed listing reads as a deleted worktree.
    if (isError) {
      return (
        <DiffNotFound
          onBack={goBack}
          message="Couldn't load worktrees."
          action={{ label: "Retry", onClick: () => void refetch() }}
        />
      );
    }
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
