import { WORKTREES_DIR } from "@shigomori/contracts/git/worktreeLayout";
import { tildify } from "@shigomori/contracts/projectPaths";
import { FirstRunView } from "@shigomori/ui/views/FirstRunView.tsx";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useKeymap } from "@/hooks/ui/useKeymap";
import { useProjects } from "@/hooks/projects/useProjects";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { ProjectGrid } from "./home/ProjectGrid";

// "/" and a fresh window land here: the projects as a grid, waiting for
// a pick, or with none (a fresh install) v2's orientation. No worktree
// opens on its own, since the sidebar would follow it into its project
// (openProject.ts) and skip the list of projects.
export function EmptyState() {
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { openAddProject } = useOverlays();
  const keys = useKeymap().get("addProject");
  const { data: runtime } = useRuntimeInfo();

  if (projectsLoading) return null;
  if (projects.length === 0) {
    // Named once this build's data dir is known (a v2 install, v3, the
    // dev app's each have their own).
    return (
      <FirstRunView
        worktreesDir={
          runtime
            ? `${tildify(runtime.dataDir, runtime.homedir)}/${WORKTREES_DIR}/`
            : null
        }
        addKeys={keys?.label ?? null}
        onAdd={() => openAddProject()}
      />
    );
  }
  return <ProjectGrid />;
}
