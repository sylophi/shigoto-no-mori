import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { LoadFailure } from "@shigomori/ui/primitives/load-failure.tsx";
import { useProjectConfigSeed } from "@/hooks/config/useProjectConfigSeed";
import { useDeviceLayout } from "@/hooks/config/useDeviceLayout";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import type { Project } from "@shigomori/contracts/schemas";
import { LocationForm } from "./LocationForm";
import { LocationPaneView, LocationSkeletonView } from "./WorktreeLocationView";

export function WorktreeLocation() {
  return (
    <ProjectDevicePage
      title="Worktree location"
      parent={{ label: "Configure", page: "configure" }}
    >
      {(scoped) => <LocationBody project={scoped} />}
    </ProjectDevicePage>
  );
}

// The layout form of whichever device the surrounding scope names.
function LocationBody({ project }: { project: Project }) {
  const projectId = project.id;
  const device = useDeviceLayout();
  const { data: worktrees = [], isLoading: worktreesLoading } =
    useWorktrees(projectId);
  const seed = useProjectConfigSeed(projectId);
  if (seed.state === "failed") {
    return (
      <LocationPaneView>
        <LoadFailure message={seed.message} onRetry={seed.retry} />
      </LocationPaneView>
    );
  }
  if (seed.state === "loading" || device === null || worktreesLoading) {
    return (
      <LocationPaneView>
        <LocationSkeletonView />
      </LocationPaneView>
    );
  }
  return (
    <LocationPaneView>
      <LocationForm
        projectId={projectId}
        projectPath={project.path}
        device={device}
        worktrees={worktrees}
        config={seed.config}
        resolvedDefaultBranch={seed.resolvedDefaultBranch}
      />
    </LocationPaneView>
  );
}
