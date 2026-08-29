import { PawPrint } from "lucide-react";
import { getRouteApi } from "@tanstack/react-router";
import { CenteredMessage } from "@/components/ui/centered-message";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useProjects } from "@/hooks/projects/useProjects";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { ConfigureForm } from "./ConfigureForm";
import { ConfigureSkeleton } from "./ConfigureSkeleton";

const route = getRouteApi("/projects/$projectId/configure");

export function ConfigureProject() {
  const { projectId } = route.useParams();
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { data: config, isLoading: configLoading } =
    useShigomoriConfig(projectId);
  const { data: resolvedDefaultBranch, isLoading: branchLoading } =
    useDefaultBranch(projectId);

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">Configure</h1>
        </div>
        {/* A terrier-sourced project is otherwise indistinguishable from a
            registered one, and the difference shows up in what you can do
            to it (no remove, no reordering). */}
        {project.source === "terrier" && (
          <SimpleTooltip tip="Registered via terrier">
            <span className="inline-flex shrink-0">
              <PawPrint
                aria-label="Registered via terrier"
                className="size-4 text-muted-foreground/70"
              />
            </span>
          </SimpleTooltip>
        )}
      </header>
      {configLoading || branchLoading || !resolvedDefaultBranch ? (
        <ConfigureSkeleton />
      ) : (
        <ConfigureForm
          key={projectId}
          projectId={projectId}
          projectPath={project.path}
          initialConfig={config ?? null}
          resolvedDefaultBranch={resolvedDefaultBranch}
        />
      )}
    </div>
  );
}
