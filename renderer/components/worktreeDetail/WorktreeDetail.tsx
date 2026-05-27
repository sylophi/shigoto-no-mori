import { CenteredMessage } from "@/components/ui/centered-message";
import { useProjects } from "@/hooks/projects/useProjects";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { worktreeRoute } from "@/router";
import { WorktreeDetailInner } from "./WorktreeDetailInner";

export function WorktreeDetail() {
  const { projectId, worktreeId } = worktreeRoute.useParams();
  const { data: projects = [] } = useProjects();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const project = projects.find((p) => p.id === projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

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
