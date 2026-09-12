import type { ReactNode } from "react";
import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { LoadFailure } from "@/components/ui/load-failure";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectConfigSeed } from "@/hooks/config/useProjectConfigSeed";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
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
  const seed = useProjectConfigSeed(projectId);
  if (seed.state === "failed") {
    return (
      <LocationPane>
        <LoadFailure message={seed.message} onRetry={seed.retry} />
      </LocationPane>
    );
  }
  if (seed.state === "loading" || runtime === undefined || worktreesLoading) {
    return (
      <LocationPane>
        <LocationSkeleton />
      </LocationPane>
    );
  }
  return (
    <LocationPane>
      <LocationForm
        projectId={projectId}
        projectPath={project.path}
        dataDir={runtime.dataDir}
        home={runtime.homedir}
        worktrees={worktrees}
        config={seed.config}
        resolvedDefaultBranch={seed.resolvedDefaultBranch}
      />
    </LocationPane>
  );
}

// The one scroll box every state of the page renders into.
function LocationPane({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="flex max-w-3xl flex-col gap-6">{children}</div>
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
