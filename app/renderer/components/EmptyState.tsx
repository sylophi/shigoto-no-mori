import { FirstRunView } from "@shigomori/ui/views/FirstRunView.tsx";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useProjects } from "@/hooks/projects/useProjects";
import { ProjectGrid } from "./home/ProjectGrid";

// "/" and a fresh window land here: the projects as a grid, waiting for
// a pick. No worktree opens on its own, since the sidebar would follow
// it into its project (openProject.ts) and skip the list of projects.
export function EmptyState() {
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { openAddProject } = useOverlays();

  if (projectsLoading) return null;
  if (projects.length === 0) {
    return <FirstRunView onAdd={() => openAddProject()} />;
  }
  return <ProjectGrid />;
}
