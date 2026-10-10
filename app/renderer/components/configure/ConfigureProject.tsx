import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { useProjectConfigSeed } from "@/hooks/config/useProjectConfigSeed";
import type { Project } from "@shigomori/contracts/schemas";
import { ConfigureForm } from "./ConfigureForm";
import { ConfigureLoadFailureView } from "./ConfigureProjectView";
import { ConfigureShared } from "./ConfigureShared";
import { ConfigureSkeletonView } from "./ConfigureSkeletonView";

export function ConfigureProject() {
  return (
    <ProjectDevicePage
      title="Configure"
      renderAllDevices={(project) => <ConfigureShared project={project} />}
    >
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
      <ConfigureLoadFailureView message={seed.message} onRetry={seed.retry} />
    );
  }
  if (seed.state === "loading") return <ConfigureSkeletonView />;
  return (
    <ConfigureForm
      key={project.id}
      projectId={project.id}
      projectPath={project.path}
      initialConfig={seed.config}
      resolvedDefaultBranch={seed.resolvedDefaultBranch}
    />
  );
}
