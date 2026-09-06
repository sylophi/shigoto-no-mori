import { PawPrint } from "lucide-react";
import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { CenteredMessage } from "@/components/ui/centered-message";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useScopedProjectParams } from "@/hooks/projects/useProjectNav";
import { useProjects } from "@/hooks/projects/useProjects";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import type { Project } from "@shared/schemas";
import { ConfigureForm } from "./ConfigureForm";
import { ConfigureSkeleton } from "./ConfigureSkeleton";

export function ConfigureProject() {
  const { projectId } = useScopedProjectParams();
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  return (
    <ProjectDevicePage
      project={project}
      title="Configure"
      // A terrier-sourced project is otherwise indistinguishable from a
      // registered one, and the difference shows up in what you can do
      // to it (no remove, no reordering).
      headerExtra={
        project.source === "terrier" && (
          <SimpleTooltip tip="Registered via terrier">
            <span className="inline-flex shrink-0">
              <PawPrint
                aria-label="Registered via terrier"
                className="size-4 text-muted-foreground/70"
              />
            </span>
          </SimpleTooltip>
        )
      }
    >
      {(scoped) => <ConfigureBody project={scoped} />}
    </ProjectDevicePage>
  );
}

// The form for whichever device the surrounding scope names, seeded
// from that device's project file and default branch.
function ConfigureBody({ project }: { project: Project }) {
  const { data: config, isLoading: configLoading } = useShigomoriConfig(
    project.id,
  );
  const { data: resolvedDefaultBranch, isLoading: branchLoading } =
    useDefaultBranch(project.id);
  if (configLoading || branchLoading || !resolvedDefaultBranch) {
    return <ConfigureSkeleton />;
  }
  return (
    <ConfigureForm
      key={project.id}
      projectId={project.id}
      projectPath={project.path}
      project={project}
      initialConfig={config ?? null}
      resolvedDefaultBranch={resolvedDefaultBranch}
    />
  );
}
