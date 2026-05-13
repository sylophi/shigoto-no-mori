import { useSelection } from "@/hooks/useSelection";
import { mockProjects } from "@/lib/mockData";
import { EmptyState } from "./EmptyState";
import { NewWorktree } from "./NewWorktree";
import { WorktreeDetail } from "./WorktreeDetail";

export function DetailPane() {
  const { mode, selectedWorktreeId, selectedProjectId } = useSelection();

  if (mode === "new-worktree" && selectedProjectId) {
    return <NewWorktree projectId={selectedProjectId} />;
  }

  if (mode === "worktree" && selectedWorktreeId) {
    for (const project of mockProjects) {
      const worktree = project.worktrees.find(
        (w) => w.id === selectedWorktreeId,
      );
      if (worktree) {
        return (
          <WorktreeDetail worktree={worktree} projectName={project.name} />
        );
      }
    }
  }

  return <EmptyState />;
}
