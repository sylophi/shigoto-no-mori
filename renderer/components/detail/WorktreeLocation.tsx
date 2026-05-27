import { CenteredMessage } from "@/components/ui/centered-message";
import { Skeleton } from "@/components/ui/skeleton";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useProjects } from "@/hooks/projects/useProjects";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { worktreeLocationRoute } from "@/router";
import { LocationForm } from "./LocationForm";

export function WorktreeLocation() {
  const { projectId } = worktreeLocationRoute.useParams();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const { data: worktrees = [], isLoading: worktreesLoading } =
    useWorktrees(projectId);
  const { data: config, isLoading: configLoading } =
    useShigomoriConfig(projectId);
  const { data: resolvedDefaultBranch, isLoading: branchLoading } =
    useDefaultBranch(projectId);

  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  const formReady =
    !configLoading &&
    !worktreesLoading &&
    !branchLoading &&
    !!runtime &&
    !!resolvedDefaultBranch;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">
            Worktree location
          </h1>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="flex max-w-3xl flex-col gap-6">
          {!formReady ? (
            <LocationSkeleton />
          ) : (
            <LocationForm
              projectId={projectId}
              projectPath={project.path}
              shigomoriRoot={runtime.shigomoriRoot}
              home={runtime.homedir}
              worktrees={worktrees}
              config={config ?? null}
              resolvedDefaultBranch={resolvedDefaultBranch}
            />
          )}
        </div>
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
