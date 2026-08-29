import {
  useScopedWorktreeParams,
  useWorktreeNav,
} from "@/hooks/worktrees/useWorktreeNav";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreeDiff } from "@/hooks/worktrees/useWorktreeDiff";
import { DiffView } from "./DiffView";
import { WorktreeMissing } from "./WorktreeMissing";

export function WorktreeDiff() {
  const { projectId, worktreeId } = useScopedWorktreeParams();
  const nav = useWorktreeNav();
  const {
    data: worktrees = [],
    isPending,
    isError,
    refetch,
  } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

  const goBack = () => nav.toWorktree(projectId, worktreeId);

  const {
    data: patch,
    isLoading,
    error,
  } = useWorktreeDiff(projectId, worktree?.id);

  if (!worktree) {
    return (
      <WorktreeMissing
        isPending={isPending}
        isError={isError}
        refetch={refetch}
        onBack={goBack}
        message="Worktree not found."
      />
    );
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
