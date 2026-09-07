import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { Skeleton } from "@/components/ui/skeleton";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import type { Project } from "@shared/schemas";
import { LocationForm } from "./LocationForm";

export function WorktreeLocation() {
  return (
    <ProjectDevicePage title="Worktree location">
      {(scoped) => <LocationBody project={scoped} />}
    </ProjectDevicePage>
  );
}

// The layout form of whichever device the surrounding scope names.
function LocationBody({ project }: { project: Project }) {
  const projectId = project.id;
  const { data: runtime } = useRuntimeInfo();
  const { data: worktrees = [], isLoading: worktreesLoading } =
    useWorktrees(projectId);
  const { data: config, isLoading: configLoading } =
    useShigomoriConfig(projectId);
  const { data: resolvedDefaultBranch, isLoading: branchLoading } =
    useDefaultBranch(projectId);

  const formReady =
    !configLoading &&
    !worktreesLoading &&
    !branchLoading &&
    !!runtime &&
    !!resolvedDefaultBranch;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="flex max-w-3xl flex-col gap-6">
        {!formReady ? (
          <LocationSkeleton />
        ) : (
          <LocationForm
            projectId={projectId}
            projectPath={project.path}
            dataDir={runtime.dataDir}
            home={runtime.homedir}
            worktrees={worktrees}
            config={config ?? null}
            resolvedDefaultBranch={resolvedDefaultBranch}
          />
        )}
      </div>
    </div>
  );
}

function LocationSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full" />
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}
