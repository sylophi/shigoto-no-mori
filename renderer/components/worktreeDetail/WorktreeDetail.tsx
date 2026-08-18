import { getRouteApi } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { useProjects } from "@/hooks/projects/useProjects";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { recordRecentWorktree } from "@/lib/recentWorktrees";
import { WorktreeDetailInner } from "./WorktreeDetailInner";

const route = getRouteApi("/projects/$projectId/worktrees/$worktreeId");

export function WorktreeDetail() {
  const { projectId, worktreeId } = route.useParams();
  const { data: projects = [], isPending: projectsPending } = useProjects();
  const {
    data: worktrees = [],
    isPending,
    isError,
    refetch,
  } = useWorktrees(projectId);
  const project = projects.find((p) => p.id === projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

  useEffect(() => {
    void window.api.git.refreshProject(projectId);
    recordRecentWorktree(projectId, worktreeId);
  }, [projectId, worktreeId]);

  if (!worktree || !project) {
    // Cold cache (e.g. a reload landing directly on this route): the
    // lists haven't resolved yet, so absence doesn't mean missing.
    if (isPending || projectsPending) return null;
    // The worktrees query is silent on error because the sidebar owns
    // that message, so without this branch a failed listing would read
    // as a deleted worktree and offer no way back.
    if (isError) {
      return (
        <CenteredMessage className="flex-col gap-3">
          Couldn't load worktrees.
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </CenteredMessage>
      );
    }
    return <CenteredMessage>Worktree not found.</CenteredMessage>;
  }

  return (
    <WorktreeDetailInner
      worktree={worktree}
      project={project}
      siblings={worktrees}
    />
  );
}
