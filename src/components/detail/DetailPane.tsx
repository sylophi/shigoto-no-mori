import { useProjects } from "@/hooks/useProjects";
import { useSelection } from "@/hooks/useSelection";
import type { Worktree } from "@shared/types";
import { useQueries } from "@tanstack/react-query";
import { EmptyState } from "./EmptyState";
import { NewWorktree } from "./NewWorktree";
import { WorktreeDetail } from "./WorktreeDetail";

export function DetailPane() {
  const { mode, selectedWorktreeId, selectedProjectId } = useSelection();
  const { data: projects = [] } = useProjects();

  // Source the selected worktree from any project's cached worktree list.
  const worktreeQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["worktrees", project.id],
      queryFn: () => window.api.worktrees.list(project.id),
      staleTime: 10_000,
    })),
  });

  if (mode === "new-worktree" && selectedProjectId) {
    return <NewWorktree projectId={selectedProjectId} />;
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
