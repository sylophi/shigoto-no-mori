import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { LoadFailure } from "@/components/ui/load-failure";
import { useProjectConfigSeed } from "@/hooks/config/useProjectConfigSeed";
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
  const seed = useProjectConfigSeed(project.id);
  if (seed.state === "failed") {
    return (
      <div className="p-6">
        <LoadFailure message={seed.message} onRetry={seed.retry} />
      </div>
    );
  }
  if (seed.state === "loading") return <ConfigureSkeleton />;
  return (
    <ConfigureForm
      key={project.id}
      projectId={project.id}
      projectPath={project.path}
      project={project}
      initialConfig={seed.config}
      resolvedDefaultBranch={seed.resolvedDefaultBranch}
    />
  );
}
