import { useProjects } from "@/hooks/useProjects";
import { useSelection } from "@/hooks/useSelection";
import { useAllProjectWorktrees } from "@/hooks/useWorktrees";
import type { Worktree } from "@shared/types";
import { ConfigureProject } from "./ConfigureProject";
import { EmptyState } from "./EmptyState";
import { NewWorktree } from "./NewWorktree";
import { Settings } from "./Settings";
import { WorktreeDetail } from "./WorktreeDetail";

export function DetailPane() {
  const { mode, selectedWorktreeId, selectedProjectId } = useSelection();
  const { data: projects = [] } = useProjects();
  const worktreeQueries = useAllProjectWorktrees(projects);

  if (mode === "settings") {
    return <Settings />;
  }

  if (mode === "new-worktree" && selectedProjectId) {
    return <NewWorktree projectId={selectedProjectId} />;
  }

  if (mode === "configure" && selectedProjectId) {
    return <ConfigureProject projectId={selectedProjectId} />;
  }

  if (mode === "worktree" && selectedWorktreeId) {
    for (let i = 0; i < projects.length; i++) {
      const trees = (worktreeQueries[i]?.data ?? []) as Worktree[];
      const match = trees.find((w) => w.id === selectedWorktreeId);
      if (match) {
        return (
          <WorktreeDetail worktree={match} projectName={projects[i].name} />
        );
      }
    }
  }

  return <EmptyState />;
}
