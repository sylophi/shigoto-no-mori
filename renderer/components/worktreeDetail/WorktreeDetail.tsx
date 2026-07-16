import { getRouteApi } from "@tanstack/react-router";
import { useEffect } from "react";
import { CenteredMessage } from "@/components/ui/centered-message";
import { useProjects } from "@/hooks/projects/useProjects";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { WorktreeDetailInner } from "./WorktreeDetailInner";

const route = getRouteApi("/projects/$projectId/worktrees/$worktreeId");

export function WorktreeDetail() {
  const { projectId, worktreeId } = route.useParams();
  const { data: projects = [] } = useProjects();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const project = projects.find((p) => p.id === projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

  useEffect(() => {
    void window.api.git.refreshProject(projectId);
  }, [projectId, worktreeId]);

  if (!worktree || !project) {
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
