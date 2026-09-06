import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import type { Project } from "@shared/schemas";
import { ConfigureForm } from "./ConfigureForm";
import { ConfigureSkeleton } from "./ConfigureSkeleton";

export function ConfigureProject() {
  return (
    <ProjectDevicePage title="Configure">
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
